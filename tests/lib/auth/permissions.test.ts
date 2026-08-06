import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

import { can, canEditProject, requirePermission, type Action } from '@/lib/auth/permissions';
import { prisma } from '@/lib/prisma';

describe('RBAC matrix(v0.3.0 两级角色)', () => {
  const admin = { role: UserRole.ADMIN } as const;
  const user = { role: UserRole.USER } as const;

  it('管理员拥有全部动作(含审批/建项目/用户列表/成员管理)', () => {
    for (const a of [
      'project:view',
      'project:create',
      'project:edit',
      'budget:editInitial',
      'budget:adjust',
      'budget:approve',
      'record:create',
      'record:void',
      'record:import',
      'audit:view',
      'user:list',
      'member:manage',
    ] as Action[]) {
      expect(can(admin, a)).toBe(true);
    }
  });

  it('普通用户全局只读:仅查看类动作,无任何编辑/审批/管理动作', () => {
    expect(can(user, 'project:view')).toBe(true);
    expect(can(user, 'audit:view')).toBe(true);
    for (const a of [
      'project:create',
      'project:edit',
      'budget:editInitial',
      'budget:adjust',
      'budget:changeSubject',
      'budget:approve',
      'record:create',
      'record:edit',
      'record:void',
      'record:import',
      'user:list',
      'member:manage',
    ] as Action[]) {
      expect(can(user, a)).toBe(false);
    }
  });

  it('未知动作一律拒绝(can 返回 false)', () => {
    expect(can(admin, 'not:exist' as Action)).toBe(false);
  });
});

describe('requirePermission 项目级编辑权(集成,真实 PG)', () => {
  let adminId: string;
  let ownerUserId: string;
  let outsiderId: string;
  let projectId: string;

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    ownerUserId = uuidv7();
    outsiderId = uuidv7();
    projectId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'perm-admin', role: UserRole.ADMIN },
        { id: ownerUserId, name: 'perm-owner', role: UserRole.USER },
        { id: outsiderId, name: 'perm-outsider', role: UserRole.USER },
      ],
    });
    await prisma.project.create({
      data: { id: projectId, code: `PERM-${uuidv7().slice(0, 8)}`, name: 'perm', ownerId: adminId },
    });
    // ownerUser 是该项目 OWNER 成员;outsider 无任何成员关系。
    await prisma.projectMember.create({
      data: {
        id: uuidv7(),
        projectId,
        userId: ownerUserId,
        memberRole: 'OWNER',
      },
    });
  });

  afterAll(async () => {
    await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { id: { in: [adminId, ownerUserId, outsiderId] } } })
      .catch(() => {});
    await prisma.$disconnect();
  });

  const admin = () => ({ id: adminId, role: UserRole.ADMIN });
  const owner = () => ({ id: ownerUserId, role: UserRole.USER });
  const outsider = () => ({ id: outsiderId, role: UserRole.USER });

  it('canEditProject:管理员恒真;OWNER 成员真;非成员假', async () => {
    await expect(canEditProject(admin(), projectId)).resolves.toBe(true);
    await expect(canEditProject(owner(), projectId)).resolves.toBe(true);
    await expect(canEditProject(outsider(), projectId)).resolves.toBe(false);
  });

  it('编辑类动作:OWNER 成员放行,非成员 403,管理员豁免成员检查', async () => {
    await expect(requirePermission(owner(), 'record:create', projectId)).resolves.toBeUndefined();
    await expect(requirePermission(outsider(), 'record:create', projectId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(requirePermission(admin(), 'record:create', projectId)).resolves.toBeUndefined();
  });

  it('查看类动作:所有登录用户对任意项目放行(全局只读)', async () => {
    await expect(requirePermission(outsider(), 'project:view', projectId)).resolves.toBeUndefined();
  });

  it('普通用户全局矩阵外动作直接 403(不到成员检查)', async () => {
    await expect(requirePermission(owner(), 'budget:approve', projectId)).rejects.toMatchObject({
      status: 403,
    });
  });
});
