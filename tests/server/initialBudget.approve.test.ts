import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApprovalStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  approveApplication,
  createDraft,
  rejectApplication,
  submitDraft,
  withdrawApplication,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';

// 集成测试直连真实 PG(:5434)。createDraft + approve 会写入 application + 科目树 +
// 三层预算(current 置位)+ 审计,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

/** 构造合法 payload:1 根(非叶)+ 2 叶,1 年度。 */
function validPayload(): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [{ year: 2026, amount: '1000.00' }],
    subjects: [
      { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
      { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
      { code: 'B', name: '叶B', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      { year: 2026, subjectCode: 'A', amount: '600.00' },
      { year: 2026, subjectCode: 'B', amount: '400.00' },
    ],
  };
}

describe('initialBudget approve/reject/withdraw (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  let ownerId: string; // 有项目访问权但非 admin(无 budget:approve)

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    ownerId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t4', role: UserRole.BUDGET_ADMIN },
    });
    await prisma.user.create({
      data: { id: ownerId, name: 'owner-t4', role: UserRole.PROJECT_OWNER },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: [adminId, ownerId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 → 返回 { project, appId, leafA, leafB }。 */
  async function seedPendingApp(suffix: string) {
    const code = `T4-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `t4 ${suffix}` }, { id: ownerId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    await submitDraft(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, appId, leafA, leafB };
  }

  it('approveApplication: 审批前 current=0;审批后三层 current=initial,application=APPROVED', async () => {
    const { project, appId, leafA } = await seedPendingApp('APPROVE');

    // 审批前:三层 current 均为 0(§6.3 createDraft 只写 initial)。
    const pbBefore = await prisma.projectBudget.findUnique({
      where: { projectId: project.id },
    });
    expect(pbBefore!.currentAmount.toFixed(2)).toBe('0.00');

    const annualBefore = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
    });
    expect(annualBefore!.currentAmount.toFixed(2)).toBe('0.00');

    const sbABefore = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: {
          projectId: project.id,
          year: 2026,
          subjectId: leafA.id,
        },
      },
    });
    expect(sbABefore!.currentAmount.toFixed(2)).toBe('0.00');

    // 审批生效。
    const result = await approveApplication(
      appId,
      { id: adminId, role: UserRole.BUDGET_ADMIN },
      '同意',
    );
    expect(result.status).toBe(ApprovalStatus.APPROVED);
    expect(result.approverId).toBe(adminId);
    expect(result.approvedAt).not.toBeNull();

    // 审批后:三层 current ← initial。
    const pbAfter = await prisma.projectBudget.findUnique({
      where: { projectId: project.id },
    });
    expect(pbAfter!.initialAmount.toFixed(2)).toBe('1000.00');
    expect(pbAfter!.currentAmount.toFixed(2)).toBe('1000.00');

    const annualAfter = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
    });
    expect(annualAfter!.initialAmount.toFixed(2)).toBe('1000.00');
    expect(annualAfter!.currentAmount.toFixed(2)).toBe('1000.00');

    const sbAAfter = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: {
          projectId: project.id,
          year: 2026,
          subjectId: leafA.id,
        },
      },
    });
    expect(sbAAfter!.initialAmount.toFixed(2)).toBe('600.00');
    expect(sbAAfter!.currentAmount.toFixed(2)).toBe('600.00');

    // application 状态。
    const app = await prisma.initialBudgetApplication.findUnique({ where: { id: appId } });
    expect(app!.status).toBe(ApprovalStatus.APPROVED);
    expect(app!.approverId).toBe(adminId);
    expect(app!.opinion).toBe('同意');

    // 审计 approve 同事务写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: appId, action: 'approve' },
    });
    expect(audit).not.toBeNull();
  });

  it('approveApplication: 非 admin(PROJECT_OWNER,无 budget:approve) → HTTPError 403', async () => {
    const { appId } = await seedPendingApp('NOADMIN');

    await expect(
      approveApplication(appId, { id: ownerId, role: UserRole.PROJECT_OWNER }, '同意'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('approveApplication: 审批非 PENDING(已 APPROVED) → HTTPError 409', async () => {
    const { appId } = await seedPendingApp('REAPP');

    // 先正常审批一次。
    await approveApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN }, '同意');

    // 再审批一次 → 409。
    await expect(
      approveApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN }, '再次同意'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejectApplication: PENDING → REJECTED,写意见,审计', async () => {
    const { appId } = await seedPendingApp('REJECT');

    const result = await rejectApplication(
      appId,
      { id: adminId, role: UserRole.BUDGET_ADMIN },
      '金额不合理',
    );
    expect(result.status).toBe(ApprovalStatus.REJECTED);

    const app = await prisma.initialBudgetApplication.findUnique({ where: { id: appId } });
    expect(app!.status).toBe(ApprovalStatus.REJECTED);
    expect(app!.opinion).toBe('金额不合理');
    expect(app!.approverId).toBe(adminId);

    // 驳回不应置位 current(仅审批生效才置位)。
    const appProjectId = app!.projectId;
    const pb = await prisma.projectBudget.findUnique({ where: { projectId: appProjectId } });
    expect(pb!.currentAmount.toFixed(2)).toBe('0.00');

    const audit = await prisma.auditLog.findFirst({
      where: { objectId: appId, action: 'reject' },
    });
    expect(audit).not.toBeNull();
  });

  it('rejectApplication: 非 PENDING → HTTPError 409', async () => {
    const { appId } = await seedPendingApp('REJ-409');
    // 先审批通过。
    await approveApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });

    await expect(
      rejectApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN }, '驳回'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('withdrawApplication: PENDING → DRAFT(§6.2 已撤回 → 草稿),审计', async () => {
    const { appId } = await seedPendingApp('WITHDRAW');

    const result = await withdrawApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });
    expect(result.status).toBe(ApprovalStatus.DRAFT);

    const app = await prisma.initialBudgetApplication.findUnique({ where: { id: appId } });
    expect(app!.status).toBe(ApprovalStatus.DRAFT);
    expect(app!.submittedAt).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { objectId: appId, action: 'withdraw' },
    });
    expect(audit).not.toBeNull();
  });

  it('withdrawApplication: 非 PENDING → HTTPError 409', async () => {
    const { appId } = await seedPendingApp('WD-409');
    // 先审批通过。
    await approveApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });

    await expect(
      withdrawApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('approveApplication: 编制单不存在 → HTTPError 404', async () => {
    await expect(
      approveApplication(uuidv7(), { id: adminId, role: UserRole.BUDGET_ADMIN }, '同意'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
