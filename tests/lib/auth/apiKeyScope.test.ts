import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey, verifyApiKey } from '@/lib/auth/api-key';
import { requirePermission } from '@/lib/auth/permissions';

/**
 * 凭证 scope 收窄集成测试(直连真实 PG):档位(只读/读写)与项目范围在
 * requirePermission 单点拦截,拒绝写审计 apikey.denied;过期凭证 401。
 */
describe('apiKey scope narrowing (integration, real PG)', () => {
  const createdUserIds: string[] = [];
  let adminId: string;
  const p1 = uuidv7();
  const p2 = uuidv7();

  async function seedKey(opts: {
    tier: string;
    projectScope?: string;
    projectIds?: string[];
    expiresAt?: Date;
  }) {
    const key = generateApiKey();
    await prisma.apiKey.create({
      data: {
        id: uuidv7(),
        userId: adminId,
        name: 'scope-test',
        keyHash: hashApiKey(key),
        prefix: apiKeyDisplayPrefix(key),
        unattended: false,
        tier: opts.tier,
        projectScope: opts.projectScope ?? 'all',
        projectIds: opts.projectIds ?? Prisma.JsonNull,
        expiresAt: opts.expiresAt ?? null,
      },
    });
    return verifyApiKey(key);
  }

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'scope-admin-test', role: UserRole.ADMIN },
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

  it('只读档:project:view 放行,record:create 拒绝 403 + apikey.denied 审计', async () => {
    const user = await seedKey({ tier: 'read' });
    expect(user?.keyTier).toBe('read');
    await expect(requirePermission(user!, 'project:view', p1)).resolves.toBeUndefined();
    await expect(requirePermission(user!, 'record:create', p1)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('凭证档位为只读'),
    });
    const denied = await prisma.auditLog.findFirst({
      where: { operatorId: adminId, action: 'apikey.denied' },
    });
    expect(denied?.afterData).toMatchObject({
      attemptedAction: 'record:create',
      keyTier: 'read',
    });
  });

  it('读写档:record:create 放行,budget:adjust 拒绝(预算/项目维护类)', async () => {
    const user = await seedKey({ tier: 'write' });
    await expect(requirePermission(user!, 'record:create', p1)).resolves.toBeUndefined();
    await expect(requirePermission(user!, 'budget:adjust', p1)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('凭证档位为读写'),
    });
  });

  it('完整档:与用户权限相同,budget:adjust(ADMIN)放行', async () => {
    const user = await seedKey({ tier: 'full' });
    await expect(requirePermission(user!, 'budget:adjust', p1)).resolves.toBeUndefined();
  });

  it('项目范围 selected:P1 放行、P2 拒绝', async () => {
    const user = await seedKey({ tier: 'full', projectScope: 'selected', projectIds: [p1] });
    await expect(requirePermission(user!, 'project:view', p1)).resolves.toBeUndefined();
    await expect(requirePermission(user!, 'project:view', p2)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('凭证未授权访问该项目'),
    });
    // 无项目上下文的动作不受项目范围约束(ADMIN 的 project:create 矩阵放行,scope 不再拦)
    await expect(requirePermission(user!, 'project:create')).resolves.toBeUndefined();
  });

  it('过期凭证:verifyApiKey → null(按 401 处理)', async () => {
    const user = await seedKey({ tier: 'read', expiresAt: new Date(Date.now() - 1000) });
    expect(user).toBeNull();
  });
});
