import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/lib/auth/session';

/**
 * 机器凭证(服务账号 API Key,ADR 0001)。
 * key 明文形如 `bma_<32hex>`,仅在创建时展示一次;库中只存 SHA-256。
 * Bearer 认证入口见 session.ts getCurrentUser;无人值守硬排除见 permissions.ts。
 */

/** key 固定前缀,与随机段一起参与展示前缀。 */
export const API_KEY_TAG = 'bma_';

/** 生成新 key:明文只在创建时返回一次。 */
export function generateApiKey(): string {
  return `${API_KEY_TAG}${randomBytes(16).toString('hex')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** 展示用前缀(bma_ + 前 6 位随机段),用于列表辨认与撤销定位。 */
export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, API_KEY_TAG.length + 6);
}

/**
 * 校验 Bearer key → 服务账号(附机器认证标记)。
 * 不存在/已撤销/账号停用 → null(上游统一按 401 处理,不区分原因避免信息泄露)。
 * 命中时刷新 lastUsedAt(失败不阻断认证)。
 */
export async function verifyApiKey(key: string): Promise<CurrentUser | null> {
  if (!key.startsWith(API_KEY_TAG)) return null;
  const rec = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(key) },
    include: { user: true },
  });
  if (!rec || rec.revokedAt) return null;
  if (rec.user.status !== 'active') return null;
  await prisma.apiKey
    .update({ where: { id: rec.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return Object.assign(rec.user, {
    viaApiKey: true as const,
    unattended: rec.unattended,
    apiKeyPrefix: rec.prefix,
  });
}
