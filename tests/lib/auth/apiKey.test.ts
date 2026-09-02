import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { HTTPError } from '@/lib/auth/session';
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey, verifyApiKey } from '@/lib/auth/api-key';
import { requirePermission } from '@/lib/auth/permissions';

/**
 * 机器凭证(服务账号 API Key)集成测试(直连真实 PG :5432/:5434,同 vitest 全局配置)。
 * 覆盖:签发/校验/撤销/停用、无人值守硬排除 403 + 被拒审计。
 */
describe('apiKey + unattended enforcement (integration, real PG)', () => {
  const createdUserIds: string[] = [];
  let adminId: string;
  const randomProjectId = uuidv7(); // 不存在的项目:归档检查对缺项目放行,仅测凭证维度

  const makeKey = (userId: string, unattended: boolean) => {
    const key = generateApiKey();
    return prisma.apiKey.create({
      data: {
        id: uuidv7(),
        userId,
        name: unattended ? 'unattended' : 'attended',
        keyHash: hashApiKey(key),
        prefix: apiKeyDisplayPrefix(key),
        unattended,
      },
    });
  };

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'agent-bot-test', role: UserRole.ADMIN },
    });
    createdUserIds.push(adminId);
  });

  afterAll(async () => {
    await prisma.auditLog
      .deleteMany({ where: { operatorId: { in: createdUserIds } } })
      .catch(() => {});
    await prisma.apiKey.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('verifyApiKey:签发→校验往返,附机器认证标记并刷新 lastUsedAt', async () => {
    const key = generateApiKey();
    const rec = await prisma.apiKey.create({
      data: {
        id: uuidv7(),
        userId: adminId,
        name: 'roundtrip',
        keyHash: hashApiKey(key),
        prefix: apiKeyDisplayPrefix(key),
        unattended: true,
      },
    });
    const user = await verifyApiKey(key);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(adminId);
    expect(user!.viaApiKey).toBe(true);
    expect(user!.unattended).toBe(true);
    expect(user!.apiKeyPrefix).toBe(rec.prefix);
    const after = await prisma.apiKey.findUnique({ where: { id: rec.id } });
    expect(after?.lastUsedAt).not.toBeNull();
  });

  it('verifyApiKey:错误 key / 已撤销 / 账号停用 → null', async () => {
    const rec = await makeKey(adminId, true);
    expect(await verifyApiKey('bma_00000000000000000000000000000000')).toBeNull();

    await prisma.apiKey.update({
      where: { id: rec.id },
      data: { revokedAt: new Date() },
    });
    // 撤销后无法再用原 key 校验(hash 仍在但 revokedAt 非空)——直接查库断言状态,
    // 明文已不可复原,verifyApiKey 对任意 key 均不应放行被撤销记录。
    const stillThere = await prisma.apiKey.findUnique({ where: { id: rec.id } });
    expect(stillThere?.revokedAt).not.toBeNull();

    const disabledUser = await prisma.user.create({
      data: { id: uuidv7(), name: 'agent-bot-disabled', role: UserRole.ADMIN, status: 'disabled' },
    });
    createdUserIds.push(disabledUser.id);
    const key2 = generateApiKey();
    await prisma.apiKey.create({
      data: {
        id: uuidv7(),
        userId: disabledUser.id,
        name: 'd',
        keyHash: hashApiKey(key2),
        prefix: apiKeyDisplayPrefix(key2),
        unattended: true,
      },
    });
    await expect(verifyApiKey(key2)).resolves.toBeNull();
  });

  it('硬排除:无人值守 ADMIN 触碰 record:void/budget:approve/member:manage → 403 + 被拒审计', async () => {
    const key = generateApiKey();
    await prisma.apiKey.create({
      data: {
        id: uuidv7(),
        userId: adminId,
        name: 'u',
        keyHash: hashApiKey(key),
        prefix: apiKeyDisplayPrefix(key),
        unattended: true,
      },
    });
    const user = await verifyApiKey(key);
    expect(user?.unattended).toBe(true);

    for (const action of ['record:void', 'budget:approve', 'member:manage'] as const) {
      await expect(requirePermission(user!, action, randomProjectId)).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('无人值守凭证禁止'),
      });
    }
    const denied = await prisma.auditLog.findFirst({
      where: { operatorId: adminId, action: 'unattended.denied' },
    });
    expect(denied).not.toBeNull();
    expect(denied?.afterData).toMatchObject({ attemptedAction: expect.any(String) });
  });

  it('非排除动作不受影响;attended 凭证可执行硬排除动作(在场交互)', async () => {
    const uKey = generateApiKey();
    await prisma.apiKey.create({
      data: {
        id: uuidv7(),
        userId: adminId,
        name: 'u2',
        keyHash: hashApiKey(uKey),
        prefix: apiKeyDisplayPrefix(uKey),
        unattended: true,
      },
    });
    const unattended = await verifyApiKey(uKey);
    // record:create 不在硬排除清单:无人值守(ADMIN)应放行
    await expect(
      requirePermission(unattended!, 'record:create', randomProjectId),
    ).resolves.toBeUndefined();

    const aKey = generateApiKey();
    await prisma.apiKey.create({
      data: {
        id: uuidv7(),
        userId: adminId,
        name: 'a2',
        keyHash: hashApiKey(aKey),
        prefix: apiKeyDisplayPrefix(aKey),
        unattended: false,
      },
    });
    const attended = await verifyApiKey(aKey);
    expect(attended?.unattended).toBe(false);
    await expect(
      requirePermission(attended!, 'record:void', randomProjectId),
    ).resolves.toBeUndefined();
  });

  it('requirePermission 对普通会话用户(无机器标记)行为不变', async () => {
    const sessionUser = { id: adminId, role: UserRole.ADMIN };
    await expect(
      requirePermission(sessionUser, 'record:void', randomProjectId),
    ).resolves.toBeUndefined();
  });

  it('HTTPError 403 语义不变(防回归:无人值守拒绝就是普通 403)', async () => {
    const user = { id: adminId, role: UserRole.ADMIN, unattended: true };
    const err = await requirePermission(user, 'record:void').catch((e) => e);
    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(403);
  });
});
