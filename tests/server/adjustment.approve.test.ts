import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AdjustmentType, ApprovalStatus, LevelType, LineDirection, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';
import { createRecord } from '@/server/services/businessRecord.service';
import {
  approveAdjustment,
  createAdjustment,
  rejectAdjustment,
  submitAdjustment,
  withdrawAdjustment,
} from '@/server/services/adjustment.service';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 审批 + 调整 + 审批生效,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.budgetLock.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetAdjustmentLine
    .deleteMany({ where: { adjustment: { projectId } } })
    .catch(() => {});
  await prisma.budgetAdjustment.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.businessRecordHistory
    .deleteMany({ where: { businessRecord: { projectId } } })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

/**
 * 合法 payload:1 根(非叶)+ 2 叶(A/B),1 年度 2026。
 * A=600、B=400,合计 1000。
 */
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
    subjectTotalBudgets: [
      { subjectCode: 'A', amount: '600.00' },
      { subjectCode: 'B', amount: '400.00' },
    ],
  };
}

describe('adjustment.approve (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  let ownerId: string; // PROJECT_OWNER:有项目访问权但无 budget:approve。
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });
  const ownerUser = () => ({ id: ownerId, role: UserRole.PROJECT_OWNER });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    ownerId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t4adj', role: UserRole.BUDGET_ADMIN },
    });
    await prisma.user.create({
      data: { id: ownerId, name: 'owner-t4adj', role: UserRole.PROJECT_OWNER },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: [adminId, ownerId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB, root }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `T4ADJ-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `t4adj ${suffix}` }, ownerUser());
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const root = subjects.find((s) => s.code === 'ROOT')!;
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, root, leafA, leafB };
  }

  it('approveAdjustment: SUBJECT_TRANSFER A→B 100 → A.current=500, B.current=500; locks released', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('OK');

    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.SUBJECT_TRANSFER,
        reason: '调剂',
        lines: [
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafA.id,
            direction: LineDirection.DECREASE,
            amount: '100.00',
          },
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafB.id,
            direction: LineDirection.INCREASE,
            amount: '100.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    // 审批前:锁存在。
    const locksBefore = await prisma.budgetLock.findMany({ where: { adjustmentId: adj.id } });
    expect(locksBefore.length).toBe(1);
    expect(locksBefore[0].releasedAt).toBeNull();

    const approved = await approveAdjustment(adj.id, adminUser(), '同意调剂');
    expect(approved.status).toBe(ApprovalStatus.APPROVED);
    expect(approved.approverId).toBe(adminId);
    expect(approved.approvedAt).not.toBeNull();

    // 生效后:A.current 600-100=500,B.current 400+100=500。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    const sbB = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafB.id },
      },
    });
    expect(sbA!.currentAmount.toFixed(2)).toBe('500.00');
    expect(sbB!.currentAmount.toFixed(2)).toBe('500.00');

    // 锁已释放(releasedAt not null)。
    const locksAfter = await prisma.budgetLock.findMany({ where: { adjustmentId: adj.id } });
    expect(locksAfter.length).toBe(1);
    expect(locksAfter[0].releasedAt).not.toBeNull();

    // 审计 approve 写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: adj.id, action: 'approve', objectType: 'budget_adjustments' },
    });
    expect(audit).not.toBeNull();
  });

  it('approveAdjustment: 提交后新增业务占用导致可调额度不足 → 422,状态仍 PENDING,锁未释放', async () => {
    const { project, leafA } = await seedApprovedProject('INSUFF');

    // A 初始 current=600。SUBJECT 单边调减 A 600(无调增,非 SUBJECT_TRANSFER 故不需平衡)。
    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.SUBJECT,
        reason: '调减 A',
        lines: [
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafA.id,
            direction: LineDirection.DECREASE,
            amount: '600.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    // 提交后,新增 100 占用到 A → 可调额度 = 600 - 100 = 500 < 600。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '100.00',
        businessDate: '2026-06-01',
        handler: '经办人A',
        summary: '审批前新增占用',
        status: 'CONTRACT',
      },
      adminUser(),
    );

    // 审批:line.amount=600 > adjustable 500 → 422。
    await expect(approveAdjustment(adj.id, adminUser(), '审批')).rejects.toMatchObject({
      status: 422,
    });

    // 失败回滚:状态 PENDING,锁未释放。
    const after = await prisma.budgetAdjustment.findUnique({ where: { id: adj.id } });
    expect(after!.status).toBe(ApprovalStatus.PENDING);
    const locks = await prisma.budgetLock.findMany({ where: { adjustmentId: adj.id } });
    expect(locks.length).toBe(1);
    expect(locks[0].releasedAt).toBeNull();

    // current 未变(未生效)。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    expect(sbA!.currentAmount.toFixed(2)).toBe('600.00');
  });

  it('rejectAdjustment: PENDING → REJECTED,释放锁,审计', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('REJ');

    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.SUBJECT_TRANSFER,
        lines: [
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafA.id,
            direction: LineDirection.DECREASE,
            amount: '100.00',
          },
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafB.id,
            direction: LineDirection.INCREASE,
            amount: '100.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const rejected = await rejectAdjustment(adj.id, adminUser(), '金额不合理');
    expect(rejected.status).toBe(ApprovalStatus.REJECTED);
    expect(rejected.approverId).toBe(adminId);

    // current 未变(驳回不生效)。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    expect(sbA!.currentAmount.toFixed(2)).toBe('600.00');

    // 锁已释放。
    const locks = await prisma.budgetLock.findMany({ where: { adjustmentId: adj.id } });
    expect(locks.length).toBe(1);
    expect(locks[0].releasedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { objectId: adj.id, action: 'reject', objectType: 'budget_adjustments' },
    });
    expect(audit).not.toBeNull();
  });

  it('withdrawAdjustment: PENDING → DRAFT,释放锁,审计', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('WD');

    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.SUBJECT_TRANSFER,
        lines: [
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafA.id,
            direction: LineDirection.DECREASE,
            amount: '50.00',
          },
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafB.id,
            direction: LineDirection.INCREASE,
            amount: '50.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const withdrawn = await withdrawAdjustment(adj.id, adminUser());
    expect(withdrawn.status).toBe(ApprovalStatus.DRAFT);

    const locks = await prisma.budgetLock.findMany({ where: { adjustmentId: adj.id } });
    expect(locks.length).toBe(1);
    expect(locks[0].releasedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { objectId: adj.id, action: 'withdraw', objectType: 'budget_adjustments' },
    });
    expect(audit).not.toBeNull();
  });

  it('approveAdjustment: 非 admin(PROJECT_OWNER 无 budget:approve) → HTTPError 403', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('NOADMIN');

    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.SUBJECT_TRANSFER,
        lines: [
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafA.id,
            direction: LineDirection.DECREASE,
            amount: '100.00',
          },
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafB.id,
            direction: LineDirection.INCREASE,
            amount: '100.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    await expect(approveAdjustment(adj.id, ownerUser(), '审批')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('approveAdjustment: 非 PENDING(已 APPROVED) → HTTPError 409', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('REAPP');

    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.SUBJECT_TRANSFER,
        lines: [
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafA.id,
            direction: LineDirection.DECREASE,
            amount: '100.00',
          },
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafB.id,
            direction: LineDirection.INCREASE,
            amount: '100.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser(), '同意');

    // 再次审批 → 409。
    await expect(approveAdjustment(adj.id, adminUser(), '再次同意')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('approveAdjustment: PROJECT_TOTAL INCREASE 200 → ProjectBudget.current 1000→1200', async () => {
    const { project } = await seedApprovedProject('PT');

    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.PROJECT_TOTAL,
        reason: '追加项目总预算',
        lines: [
          {
            levelType: LevelType.PROJECT,
            direction: LineDirection.INCREASE,
            amount: '200.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const pbBefore = await prisma.projectBudget.findUnique({ where: { projectId: project.id } });
    expect(pbBefore!.currentAmount.toFixed(2)).toBe('1000.00');

    await approveAdjustment(adj.id, adminUser(), '追加');

    const pbAfter = await prisma.projectBudget.findUnique({ where: { projectId: project.id } });
    expect(pbAfter!.currentAmount.toFixed(2)).toBe('1200.00');
  });
});
