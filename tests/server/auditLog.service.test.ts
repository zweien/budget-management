import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemberRole, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { listAuditLogs } from '@/server/services/auditLog.service';

// 集成测试直连真实 PG(:5434)。createProject 在事务内建 project + budget + member +
// 一条 auditLog('create')。需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecordHistory
    .deleteMany({ where: { businessRecord: { projectId } } })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('auditLog.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  let outsiderId: string; // 无任何项目访问权限的非管理员
  let memberUserId: string; // 被加入某项目成员的非管理员

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    memberUserId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-audit', role: UserRole.BUDGET_ADMIN },
    });
    await prisma.user.create({
      data: { id: outsiderId, name: 'outsider-audit', role: UserRole.AUTHORIZED_HANDLER },
    });
    await prisma.user.create({
      data: { id: memberUserId, name: 'member-audit', role: UserRole.AUTHORIZED_HANDLER },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user
      .deleteMany({ where: { id: { in: [adminId, outsiderId, memberUserId] } } })
      .catch(() => {});
    await prisma.$disconnect();
  });

  it('admin 建项目生成 audit_logs:listAuditLogs(admin) 看到对应 create 日志', async () => {
    const code = `AU-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'audit-admin' }, { id: adminId });
    createdProjectIds.push(project.id);

    const { logs, total } = await listAuditLogs(
      { projectId: project.id },
      { id: adminId, role: UserRole.BUDGET_ADMIN },
    );

    expect(total).toBeGreaterThanOrEqual(1);
    const create = logs.find((l) => l.action === 'create' && l.objectType === 'project');
    expect(create).toBeTruthy();
    expect(create!.objectId).toBe(project.id);
    expect(create!.operatorId).toBe(adminId);
    expect(create!.operator.name).toBe('admin-audit');
  });

  it('非 admin 且无项目访问权:返回空集(不抛 403,不泄露项目存在性)', async () => {
    const code = `AU2-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'audit-hidden' }, { id: adminId });
    createdProjectIds.push(project.id);

    const { logs, total } = await listAuditLogs(
      { projectId: project.id },
      { id: outsiderId, role: UserRole.AUTHORIZED_HANDLER },
    );

    expect(total).toBe(0);
    expect(logs).toEqual([]);
  });

  it('非 admin 被加入项目成员:仅看到该项目的日志(跨项目隔离)', async () => {
    // 项目 A:把 memberUserId 加为成员。
    const codeA = `AU3A-${uuidv7().slice(0, 8)}`;
    const projectA = await createProject({ code: codeA, name: 'audit-A' }, { id: adminId });
    createdProjectIds.push(projectA.id);
    await prisma.projectMember.create({
      data: {
        id: uuidv7(),
        projectId: projectA.id,
        userId: memberUserId,
        memberRole: MemberRole.HANDLER,
      },
    });

    // 项目 B:成员不属于该项目。
    const codeB = `AU3B-${uuidv7().slice(0, 8)}`;
    const projectB = await createProject({ code: codeB, name: 'audit-B' }, { id: adminId });
    createdProjectIds.push(projectB.id);

    // member 视角全量查询:应只看到 A 的日志,不含 B。
    const { logs, total } = await listAuditLogs(
      {},
      { id: memberUserId, role: UserRole.AUTHORIZED_HANDLER },
    );

    // A 的 create 日志在内。
    const aCreate = logs.find((l) => l.projectId === projectA.id && l.action === 'create');
    expect(aCreate).toBeTruthy();
    // B 的任何日志都不应出现。
    const bLeak = logs.find((l) => l.projectId === projectB.id);
    expect(bLeak).toBeUndefined();
    // total 不超过 A 相关日志数(至少 1 条),且不包含 B。
    expect(total).toBe(logs.length);
    expect(total).toBeGreaterThanOrEqual(1);

    // 显式按 A 查询也能命中。
    const byA = await listAuditLogs(
      { projectId: projectA.id },
      { id: memberUserId, role: UserRole.AUTHORIZED_HANDLER },
    );
    expect(byA.logs.every((l) => l.projectId === projectA.id)).toBe(true);
    expect(byA.total).toBeGreaterThanOrEqual(1);

    // 显式按 B 查询:member 无权,应返回空。
    const byB = await listAuditLogs(
      { projectId: projectB.id },
      { id: memberUserId, role: UserRole.AUTHORIZED_HANDLER },
    );
    expect(byB.total).toBe(0);
    expect(byB.logs).toEqual([]);
  });

  it('按 objectType 过滤:只返回匹配对象类型', async () => {
    const code = `AU4-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'audit-filter' }, { id: adminId });
    createdProjectIds.push(project.id);

    const { logs, total } = await listAuditLogs(
      { projectId: project.id, objectType: 'project' },
      { id: adminId, role: UserRole.BUDGET_ADMIN },
    );

    expect(total).toBeGreaterThanOrEqual(1);
    expect(logs.every((l) => l.objectType === 'project')).toBe(true);

    // 用一个不可能存在的对象类型过滤:应为空。
    const empty = await listAuditLogs(
      { projectId: project.id, objectType: 'no_such_type' },
      { id: adminId, role: UserRole.BUDGET_ADMIN },
    );
    expect(empty.total).toBe(0);
    expect(empty.logs).toEqual([]);
  });

  it('分页 limit/offset 生效', async () => {
    const code = `AU5-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'audit-page' }, { id: adminId });
    createdProjectIds.push(project.id);

    const all = await listAuditLogs(
      { projectId: project.id },
      { id: adminId, role: UserRole.BUDGET_ADMIN },
    );
    expect(all.total).toBeGreaterThanOrEqual(1);

    const first = await listAuditLogs(
      { projectId: project.id },
      { id: adminId, role: UserRole.BUDGET_ADMIN },
      { limit: 1, offset: 0 },
    );
    expect(first.logs.length).toBe(1);
    expect(first.total).toBe(all.total);

    // offset 超出范围 → 空列表但 total 不变。
    const beyond = await listAuditLogs(
      { projectId: project.id },
      { id: adminId, role: UserRole.BUDGET_ADMIN },
      { limit: 1, offset: 1000 },
    );
    expect(beyond.logs).toEqual([]);
    expect(beyond.total).toBe(all.total);
  });
});
