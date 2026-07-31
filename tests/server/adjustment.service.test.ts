import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AdjustmentType, ApprovalStatus, LevelType, LineDirection, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { fromStored } from '@/lib/decimal';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';
import { createRecord } from '@/server/services/businessRecord.service';
import {
  createAdjustment,
  getAdjustment,
  listAdjustments,
  submitAdjustment,
} from '@/server/services/adjustment.service';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 审批 + 调整,需级联清理。
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

describe('adjustment.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t3', role: UserRole.BUDGET_ADMIN },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB, root }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `T3-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `t3 ${suffix}` }, { id: adminId });
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

  it('createAdjustment: SUBJECT_TRANSFER 平衡(DECREASE A 100, INCREASE B 100)→ DRAFT', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('BAL');

    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.SUBJECT_TRANSFER,
        reason: '调剂测试',
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

    expect(adj.status).toBe(ApprovalStatus.DRAFT);
    expect(adj.type).toBe(AdjustmentType.SUBJECT_TRANSFER);
    expect(adj.applicantId).toBe(adminId);
    expect(adj.reason).toBe('调剂测试');

    // 审计 create 写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: adj.id, action: 'create', objectType: 'budget_adjustments' },
    });
    expect(audit).not.toBeNull();

    // 草稿阶段不应有任何锁。
    const locks = await prisma.budgetLock.findMany({ where: { adjustmentId: adj.id } });
    expect(locks.length).toBe(0);
  });

  it('createAdjustment: SUBJECT_TRANSFER 不平衡(DECREASE 100, INCREASE 50)→ 422', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('UNBAL');

    await expect(
      createAdjustment(
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
              amount: '50.00',
            },
          ],
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('createAdjustment: PROJECT_TOTAL 行误带 subjectId → 422', async () => {
    const { project, leafA } = await seedApprovedProject('BADLINE');

    await expect(
      createAdjustment(
        project.id,
        {
          type: AdjustmentType.PROJECT_TOTAL,
          lines: [
            {
              levelType: LevelType.PROJECT,
              subjectId: leafA.id,
              direction: LineDirection.INCREASE,
              amount: '100.00',
            },
          ],
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('submitAdjustment: SUBJECT_TRANSFER 写 A 的 budget_lock(100);可操作额度=500', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('LOCK');

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

    const submitted = await submitAdjustment(adj.id, adminUser());
    expect(submitted.status).toBe(ApprovalStatus.PENDING);

    // 锁:只有 1 条(DECREASE A 100),B 是 INCREASE 不锁。
    const locks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id },
      orderBy: { subjectId: 'asc' },
    });
    expect(locks.length).toBe(1);
    expect(locks[0].subjectId).toBe(leafA.id);
    expect(locks[0].year).toBe(2026);
    expect(locks[0].amount.toFixed(2)).toBe('100.00');
    expect(locks[0].releasedAt).toBeNull();

    // §7.4 可调额度 = 600 - 0(占用) = 600;可操作额度 = 600 - 0 - 100(锁) = 500。
    const subjectBudgetA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    expect(subjectBudgetA!.currentAmount.toFixed(2)).toBe('600.00');
    const pendingLock = fromStored(locks[0].amount);
    const operable = fromStored(subjectBudgetA!.currentAmount).minus(pendingLock);
    expect(operable.toFixed(2)).toBe('500.00');

    // 审计 submit 写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: adj.id, action: 'submit', objectType: 'budget_adjustments' },
    });
    expect(audit).not.toBeNull();
  });

  it('submitAdjustment: DECREASE A 700 > 可调额度 600 → 422,状态不变', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('OVER');

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
            amount: '700.00',
          },
          {
            levelType: LevelType.SUBJECT,
            year: 2026,
            subjectId: leafB.id,
            direction: LineDirection.INCREASE,
            amount: '700.00',
          },
        ],
      },
      adminUser(),
    );

    await expect(submitAdjustment(adj.id, adminUser())).rejects.toMatchObject({ status: 422 });

    // 失败回滚:状态仍为 DRAFT,无锁。
    const after = await prisma.budgetAdjustment.findUnique({ where: { id: adj.id } });
    expect(after!.status).toBe(ApprovalStatus.DRAFT);
    const locks = await prisma.budgetLock.findMany({ where: { adjustmentId: adj.id } });
    expect(locks.length).toBe(0);
  });

  it('submitAdjustment: 已 PENDING 再提交 → 409', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('TWICE');

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
    await expect(submitAdjustment(adj.id, adminUser())).rejects.toMatchObject({ status: 409 });
  });

  it('submitAdjustment: PROJECT_TOTAL DECREASE 低于项目占用 → 422', async () => {
    const { project, leafA } = await seedApprovedProject('PTOVER');

    // 先制造占用:在 A 上登记 300 的业务记录。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '300.00',
        businessDate: '2026-06-01',
        handler: '经办人A',
        summary: '占用',
        status: 'CONTRACT',
      },
      adminUser(),
    );

    // 项目总额当前 = 1000,占用 300,可调 = 700。调减 800 > 700 → 422。
    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.PROJECT_TOTAL,
        lines: [
          {
            levelType: LevelType.PROJECT,
            direction: LineDirection.DECREASE,
            amount: '800.00',
          },
        ],
      },
      adminUser(),
    );

    await expect(submitAdjustment(adj.id, adminUser())).rejects.toMatchObject({ status: 422 });

    // 可调额度内的 PROJECT_TOTAL DECREASE 应当通过(700 ≤ 700)。
    const adj2 = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.PROJECT_TOTAL,
        lines: [
          {
            levelType: LevelType.PROJECT,
            direction: LineDirection.DECREASE,
            amount: '700.00',
          },
        ],
      },
      adminUser(),
    );
    const submitted = await submitAdjustment(adj2.id, adminUser());
    expect(submitted.status).toBe(ApprovalStatus.PENDING);

    // §7.4 V1 决策:PROJECT_TOTAL 不写叶节点锁。
    const locks = await prisma.budgetLock.findMany({ where: { adjustmentId: adj2.id } });
    expect(locks.length).toBe(0);
  });

  it('submitAdjustment: ANNUAL DECREASE 低于年度占用 → 422', async () => {
    const { project, leafB } = await seedApprovedProject('ANNOVER');

    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafB.id,
        amount: '100.00',
        businessDate: '2026-06-02',
        handler: '经办人A',
        summary: '占用',
        status: 'PLACEHOLDER',
      },
      adminUser(),
    );

    // 年度当前 = 1000,占用 100,可调 = 900。调减 950 > 900 → 422。
    const adj = await createAdjustment(
      project.id,
      {
        type: AdjustmentType.ANNUAL,
        lines: [
          {
            levelType: LevelType.ANNUAL,
            year: 2026,
            direction: LineDirection.DECREASE,
            amount: '950.00',
          },
        ],
      },
      adminUser(),
    );

    await expect(submitAdjustment(adj.id, adminUser())).rejects.toMatchObject({ status: 422 });
  });

  it('getAdjustment / listAdjustments: 包含明细 + 锁', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('GET');

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

    const got = await getAdjustment(adj.id, adminUser());
    expect(got.id).toBe(adj.id);
    expect(got.lines.length).toBe(2);
    expect(got.locks.length).toBe(0);

    const list = await listAdjustments(project.id, adminUser());
    expect(list.length).toBeGreaterThanOrEqual(1);
    const found = list.find((a) => a.id === adj.id);
    expect(found).toBeDefined();
    expect(found!.lines.length).toBe(2);
  });
});
