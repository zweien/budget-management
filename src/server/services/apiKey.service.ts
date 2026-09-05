import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { HTTPError } from '@/lib/auth/session';
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { recordAudit } from '@/server/audit/interceptor';

/**
 * API 凭证管理(ADR 0001):签发/列表/撤销,脚本(make-agent)与管理 UI 共用。
 * 红线:凭证管理仅限登录会话——Bearer 凭证一律拒绝,防 agent 自我签发凭证。
 * scope 语义:只收窄不放大,实际权限 = 用户权限 ∩ 凭证范围(档位/项目范围)。
 */

export type ApiKeyTier = 'read' | 'write' | 'full';
export type ApiKeyProjectScope = 'all' | 'selected';

export const API_KEY_TIERS: ApiKeyTier[] = ['read', 'write', 'full'];

const MAX_NAME_LENGTH = 64;
const MAX_EXPIRY_DAYS = 3650;
/** 指定项目范围的上限(防误传超大列表)。 */
const MAX_PROJECT_IDS = 50;

export interface CreateApiKeyInput {
  name: string;
  /** 无人值守:硬排除动作(作废/审批/成员管理)在服务端拒绝。 */
  unattended: boolean;
  tier: ApiKeyTier;
  projectScope: ApiKeyProjectScope;
  /** projectScope='selected' 时必填(项目 UUID)。 */
  projectIds?: string[];
  /** 有效期天数(自签发起算);缺省永不过期。 */
  expiresInDays?: number | null;
}

/** 凭证管理仅限人在场交互会话:Bearer 凭证(含 attended)一律 403。 */
export function assertInteractiveSession(user: { viaApiKey?: boolean }): void {
  if (user.viaApiKey) {
    throw new HTTPError(403, 'API 凭证管理仅限登录会话使用,机器凭证不得调用');
  }
}

/** 签发凭证(供自助创建与管理脚本);明文仅此一次返回,库中只存哈希。 */
export async function issueApiKey(
  input: CreateApiKeyInput & { userId: string },
): Promise<{ record: Prisma.ApiKeyGetPayload<Record<string, never>>; plaintext: string }> {
  const name = input.name?.trim();
  if (!name) throw new HTTPError(422, '凭证名称不能为空');
  if (name.length > MAX_NAME_LENGTH)
    throw new HTTPError(422, `凭证名称过长(≤${MAX_NAME_LENGTH} 字)`);
  if (!API_KEY_TIERS.includes(input.tier)) {
    throw new HTTPError(422, `凭证档位无效:${input.tier}(应为 read/write/full)`);
  }
  // 枚举严校验(codex P1):未知的 projectScope 一律拒绝,
  // 否则会被权限层当作 'all' 处理——凭证实际范围比用户请求的更宽。
  if (input.projectScope !== 'all' && input.projectScope !== 'selected') {
    throw new HTTPError(422, `项目范围无效:${input.projectScope}(应为 all/selected)`);
  }
  const uniqueProjectIds = [...new Set(input.projectIds ?? [])];
  if (input.projectScope === 'selected') {
    if (uniqueProjectIds.length === 0) {
      throw new HTTPError(422, '指定项目范围时至少选择一个项目');
    }
    if (uniqueProjectIds.length > MAX_PROJECT_IDS) {
      throw new HTTPError(422, `指定项目数量过多(≤${MAX_PROJECT_IDS})`);
    }
    const count = await prisma.project.count({ where: { id: { in: uniqueProjectIds } } });
    if (count !== uniqueProjectIds.length) {
      throw new HTTPError(422, '项目列表含无效项目');
    }
  }
  let expiresAt: Date | null = null;
  if (input.expiresInDays != null) {
    const days = Math.floor(input.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
      throw new HTTPError(422, `有效期应为 1-${MAX_EXPIRY_DAYS} 天(留空=永不过期)`);
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const plaintext = generateApiKey();
  // 签发与审计同事务(§14.2):凭证是越权高价值目标,签发必留痕(不含哈希/明文)。
  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.apiKey.create({
      data: {
        id: uuidv7(),
        userId: input.userId,
        name,
        keyHash: hashApiKey(plaintext),
        prefix: apiKeyDisplayPrefix(plaintext),
        unattended: input.unattended,
        tier: input.tier,
        projectScope: input.projectScope,
        projectIds: input.projectScope === 'selected' ? uniqueProjectIds : Prisma.JsonNull,
        expiresAt,
      },
    });
    await recordAudit(tx, {
      objectType: 'api_keys',
      objectId: created.id,
      action: 'apikey.issue',
      operatorId: input.userId,
      after: toPublicApiKey(created) as unknown as Record<string, unknown>,
    });
    return created;
  });
  return { record, plaintext };
}

/** 对外可见字段(绝不包含 keyHash——哈希不出库,明文仅签发瞬间存在)。 */
export type ApiKeyPublic = Pick<
  Prisma.ApiKeyGetPayload<Record<string, never>>,
  | 'id'
  | 'name'
  | 'prefix'
  | 'unattended'
  | 'tier'
  | 'projectScope'
  | 'projectIds'
  | 'expiresAt'
  | 'lastUsedAt'
  | 'revokedAt'
  | 'createdAt'
>;

export function toPublicApiKey(rec: Prisma.ApiKeyGetPayload<Record<string, never>>): ApiKeyPublic {
  return {
    id: rec.id,
    name: rec.name,
    prefix: rec.prefix,
    unattended: rec.unattended,
    tier: rec.tier,
    projectScope: rec.projectScope,
    projectIds: rec.projectIds,
    expiresAt: rec.expiresAt,
    lastUsedAt: rec.lastUsedAt,
    revokedAt: rec.revokedAt,
    createdAt: rec.createdAt,
  };
}

/** 列出某用户的全部凭证(创建时间倒序;仅公开字段)。 */
export async function listApiKeys(userId: string): Promise<ApiKeyPublic[]> {
  const rows = await prisma.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      unattended: true,
      tier: true,
      projectScope: true,
      projectIds: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  return rows;
}

/** 撤销凭证(仅限本人;脚本场景先自行按前缀定位再调用)。已撤销幂等返回。 */
export async function revokeApiKey(userId: string, keyId: string): Promise<ApiKeyPublic> {
  const rec = await prisma.apiKey.findFirst({ where: { id: keyId, userId } });
  if (!rec) throw new HTTPError(404, '凭证不存在');
  if (rec.revokedAt) return toPublicApiKey(rec);
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.apiKey.update({
      where: { id: rec.id },
      data: { revokedAt: new Date() },
    });
    await recordAudit(tx, {
      objectType: 'api_keys',
      objectId: row.id,
      action: 'apikey.revoke',
      operatorId: userId,
      before: toPublicApiKey(rec) as unknown as Record<string, unknown>,
      after: toPublicApiKey(row) as unknown as Record<string, unknown>,
    });
    return row;
  });
  return toPublicApiKey(updated);
}
