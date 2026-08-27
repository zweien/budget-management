import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  archiveProject,
  createProject,
  listProjects,
  getProject,
  unarchiveProject,
  updateProject,
} from '@/server/services/project.service';

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
      data: { id: adminId, name: 'admin-t1', role: UserRole.ADMIN },
    });
    await prisma.user.create({
      data: {
        id: outsiderId,
        name: 'outsider-t1',
        role: UserRole.USER,
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
      { id: adminId, role: UserRole.ADMIN },
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
    const first = await createProject(
      { code, name: 'first' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(first.id);

    await expect(
      createProject({ code, name: 'second' }, { id: adminId, role: UserRole.ADMIN }),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect.assertions(1);
  });

  it('listProjects: admin 返回全部(含本测试创建的项目)', async () => {
    const code = `LST-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'list test' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const list = await listProjects({ id: adminId, role: UserRole.ADMIN });
    expect(list.map((p) => p.id)).toContain(project.id);
  });

  it('listProjects: 普通用户可见全部项目(v0.3.0 全局只读)', async () => {
    const code = `LST2-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'admin only' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const list = await listProjects({
      id: outsiderId,
      role: UserRole.USER,
    });
    expect(list.map((p) => p.id)).toContain(project.id);
  });

  it('getProject: 普通用户可查看任意项目详情(只读)', async () => {
    const code = `VIP-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'admin private' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const got = await getProject(project.id, {
      id: outsiderId,
      role: UserRole.USER,
    });
    expect(got.id).toBe(project.id);
  });

  it('createProject: 普通用户无权新建项目(403)', async () => {
    const code = `NOPERM-${uuidv7().slice(0, 8)}`;
    await expect(
      createProject({ code, name: 'forbidden' }, { id: outsiderId, role: UserRole.USER }),
    ).rejects.toMatchObject({ status: 403 });
    expect.assertions(1);
  });

  it('§项目管理:updateProject 改可改字段;code 不可改;canEdit 随行下发', async () => {
    const code = `UPD-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'before', level: '校级' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const after = await updateProject(
      project.id,
      { name: 'after', level: '国家级', remark: 'updated' },
      { id: adminId, role: UserRole.ADMIN },
    );
    expect(after.name).toBe('after');
    expect(after.level).toBe('国家级');
    expect(after.code).toBe(code); // 编号不可改

    // 审计:update。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: project.id, action: 'update' },
    });
    expect(audit).not.toBeNull();

    // 列表行带 canEdit:ADMIN 恒 true;非 OWNER 普通用户 false。
    const adminList = await listProjects({ id: adminId, role: UserRole.ADMIN });
    expect(adminList.find((p) => p.id === project.id)?.canEdit).toBe(true);
    const outsiderList = await listProjects({ id: outsiderId, role: UserRole.USER });
    expect(outsiderList.find((p) => p.id === project.id)?.canEdit).toBe(false);
  });

  it('§项目管理:归档后默认列表隐藏,includeArchived 可见,恢复后回归默认列表', async () => {
    const code = `ARC-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'archive me' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    // 归档。
    const archived = await archiveProject(project.id, { id: adminId, role: UserRole.ADMIN });
    expect(archived.archivedAt).not.toBeNull();

    // 默认列表不含;includeArchived 含(带 archivedAt)。
    const visible = await listProjects({ id: adminId, role: UserRole.ADMIN });
    expect(visible.map((p) => p.id)).not.toContain(project.id);
    const withArchived = await listProjects(
      { id: adminId, role: UserRole.ADMIN },
      {
        includeArchived: true,
      },
    );
    const row = withArchived.find((p) => p.id === project.id);
    expect(row).toBeDefined();
    expect(row!.archivedAt).not.toBeNull();

    // 审计:archive。
    const archiveAudit = await prisma.auditLog.findFirst({
      where: { objectId: project.id, action: 'archive' },
    });
    expect(archiveAudit).not.toBeNull();

    // 恢复。
    const restored = await unarchiveProject(project.id, { id: adminId, role: UserRole.ADMIN });
    expect(restored.archivedAt).toBeNull();
    const visibleAgain = await listProjects({ id: adminId, role: UserRole.ADMIN });
    expect(visibleAgain.map((p) => p.id)).toContain(project.id);
    const unarchiveAudit = await prisma.auditLog.findFirst({
      where: { objectId: project.id, action: 'unarchive' },
    });
    expect(unarchiveAudit).not.toBeNull();
  });

  it('§项目管理:普通用户(非 OWNER)归档/恢复/更新均 403', async () => {
    const code = `DENY-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'deny me' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    await expect(
      updateProject(project.id, { name: 'x' }, { id: outsiderId, role: UserRole.USER }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      archiveProject(project.id, { id: outsiderId, role: UserRole.USER }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      unarchiveProject(project.id, { id: outsiderId, role: UserRole.USER }),
    ).rejects.toMatchObject({ status: 403 });
    expect.assertions(3);
  });

  it('getProject: 有权限(admin)可正常取回', async () => {
    const code = `OK-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'visible' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const got = await getProject(project.id, {
      id: adminId,
      role: UserRole.ADMIN,
    });
    expect(got.id).toBe(project.id);
  });
});
