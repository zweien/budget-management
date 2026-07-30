import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { HTTPError } from '@/lib/auth/session';
import { createProject, listProjects, getProject } from '@/server/services/project.service';

// 集成测试直连真实 PG(:5434)。createProject 在事务内建 project + budget + member,
// 需级联清理;ProjectBudget / ProjectMember 无独立查询入口,通过 projectId 一并清。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('project.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  let outsiderId: string; // 无任何项目访问权限的非管理员

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t1', role: UserRole.BUDGET_ADMIN },
    });
    await prisma.user.create({
      data: {
        id: outsiderId,
        name: 'outsider-t1',
        role: UserRole.AUTHORIZED_HANDLER,
      },
    });
  });

  afterEach(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [adminId, outsiderId] } } });
    await prisma.$disconnect();
  });

  it('createProject: 事务内建 project + budget(0) + owner member', async () => {
    const code = `T1-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: '集成测试项目', remark: 't1' },
      { id: adminId },
    );
    createdProjectIds.push(project.id);

    expect(project.code).toBe(code);
    expect(project.ownerId).toBe(adminId);

    // ProjectBudget 初始/当前均为 0。
    const budget = await prisma.projectBudget.findUnique({
      where: { projectId: project.id },
    });
    expect(budget).not.toBeNull();
    expect(budget!.initialAmount.toNumber()).toBe(0);
    expect(budget!.currentAmount.toNumber()).toBe(0);

    // owner 自动加入为 OWNER 成员。
    const member = await prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: project.id, userId: adminId },
      },
    });
    expect(member?.memberRole).toBe('OWNER');

    // 审计同事务写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: project.id, action: 'create' },
    });
    expect(audit).not.toBeNull();
  });

  it('createProject: code 冲突抛 HTTPError 409', async () => {
    const code = `DUP-${uuidv7().slice(0, 8)}`;
    const first = await createProject({ code, name: 'first' }, { id: adminId });
    createdProjectIds.push(first.id);

    await expect(createProject({ code, name: 'second' }, { id: adminId })).rejects.toMatchObject({
      status: 409,
    });
    expect.assertions(1);
  });

  it('listProjects: admin 返回全部(含本测试创建的项目)', async () => {
    const code = `LST-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'list test' }, { id: adminId });
    createdProjectIds.push(project.id);

    const list = await listProjects({ id: adminId, role: UserRole.BUDGET_ADMIN });
    expect(list.map((p) => p.id)).toContain(project.id);
  });

  it('listProjects: 无项目权限的非管理员看不到他人项目', async () => {
    const code = `LST2-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'admin only' }, { id: adminId });
    createdProjectIds.push(project.id);

    const list = await listProjects({
      id: outsiderId,
      role: UserRole.AUTHORIZED_HANDLER,
    });
    expect(list.map((p) => p.id)).not.toContain(project.id);
  });

  it('getProject: 越权访问他人项目抛 HTTPError 403', async () => {
    const code = `VIP-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'admin private' }, { id: adminId });
    createdProjectIds.push(project.id);

    await expect(
      getProject(project.id, {
        id: outsiderId,
        role: UserRole.AUTHORIZED_HANDLER,
      }),
    ).rejects.toBeInstanceOf(HTTPError);
    expect.assertions(1);
  });

  it('getProject: 有权限(admin)可正常取回', async () => {
    const code = `OK-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'visible' }, { id: adminId });
    createdProjectIds.push(project.id);

    const got = await getProject(project.id, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    expect(got.id).toBe(project.id);
  });
});
