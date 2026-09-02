import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey, verifyApiKey } from '@/lib/auth/api-key';
import { requirePermission, denyApiKeyCrossProject } from '@/lib/auth/permissions';
import { listProjects } from '@/server/services/project.service';

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

  it('项目范围 selected:P1 放行、P2 拒绝;无项目上下文动作拒绝(codex P1)', async () => {
    const user = await seedKey({ tier: 'full', projectScope: 'selected', projectIds: [p1] });
    await expect(requirePermission(user!, 'project:view', p1)).resolves.toBeUndefined();
    await expect(requirePermission(user!, 'project:view', p2)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('凭证未授权访问该项目'),
    });
    // 无项目上下文的动作(如建项目)同样拒绝——防跨项目接口绕过
    await expect(requirePermission(user!, 'project:create')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('禁止执行跨项目操作'),
    });
    // project:view 列表类豁免(scope 拒绝;service 层过滤到 allowlist)
    await expect(requirePermission(user!, 'project:view')).resolves.toBeUndefined();
  });

  it('denyApiKeyCrossProject:跨项目接口门卫(统计/审计/审批/用户列表用)', () => {
    const base = { id: 'u1', role: UserRole.USER };
    expect(() =>
      denyApiKeyCrossProject({ ...base, viaApiKey: true, keyProjectScope: 'selected' }),
    ).toThrow(
      expect.objectContaining({ status: 403, message: expect.stringContaining('跨项目接口') }),
    );
    // 全部项目范围/会话用户不受影响
    expect(() =>
      denyApiKeyCrossProject({ ...base, viaApiKey: true, keyProjectScope: 'all' }),
    ).not.toThrow();
    expect(() => denyApiKeyCrossProject({ ...base })).not.toThrow();
  });

  it('过期凭证:verifyApiKey → null(按 401 处理)', async () => {
    const user = await seedKey({ tier: 'read', expiresAt: new Date(Date.now() - 1000) });
    expect(user).toBeNull();
  });

  it('listProjects:selected-scope 凭证仅返回 allowlist 项目(codex P1)', async () => {
    // 建两个真实项目(p1 在 allowlist,p2 不在)
    for (const [pid, code] of [
      [p1, `SC1-${uuidv7().slice(-8)}`],
      [p2, `SC2-${uuidv7().slice(-8)}`],
    ] as const) {
      const created = await prisma.project.create({
        data: { id: pid, code, name: code, ownerId: adminId },
      });
      void created;
    }
    const user = await seedKey({ tier: 'full', projectScope: 'selected', projectIds: [p1] });
    const rows = await listProjects(user!);
    expect(rows.map((r) => r.id)).toEqual([p1]);
    // 会话用户(无凭证标记)不受影响:全量列表包含两个测试项目(共享开发库可能还有其他项目)
    const all = await listProjects({ id: adminId, role: UserRole.ADMIN });
    const allIds = all.map((r) => r.id);
    expect(allIds).toContain(p1);
    expect(allIds).toContain(p2);
    await prisma.project.deleteMany({ where: { id: { in: [p1, p2] } } });
  });
});
