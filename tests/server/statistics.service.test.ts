import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, UserRole } from '@prisma/client';

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
  crossProjectStatistics,
  customStatistics,
  monthlyHistory,
} from '@/server/services/statistics.service';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 业务记录,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
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
 * 构造合法 payload:1 根(非叶)+ 2 叶(A/B),1 年度 2026。
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
      // §enhance3:金额 = 数量 × 单价(service 端重算)。A 6×100=600;B 4×100=400。
      {
        year: 2026,
        subjectCode: 'A',
        amount: '600.00',
        unit: '次',
        quantity: '6.00',
        unitPrice: '100.00',
      },
      {
        year: 2026,
        subjectCode: 'B',
        amount: '400.00',
        unit: '次',
        quantity: '4.00',
        unitPrice: '100.00',
      },
    ],
    subjectTotalBudgets: [
      { subjectCode: 'A', amount: '600.00' },
      { subjectCode: 'B', amount: '400.00' },
    ],
  };
}

describe('statistics.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let outsiderId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });
  const outsiderUser = () => ({ id: outsiderId, role: UserRole.AUTHORIZED_HANDLER });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'admin-stat', role: UserRole.BUDGET_ADMIN },
        { id: outsiderId, name: 'outsider-stat', role: UserRole.AUTHORIZED_HANDLER },
      ],
    });
    createdUserIds.push(adminId, outsiderId);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `STAT-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `stat ${suffix}` }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, leafA, leafB };
  }

  // ---------------- customStatistics(§11.3) ----------------

  it('customStatistics: projectId+year 筛选 → summary 占用与记录一致;预算来自 subject_budgets', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('CUSTOM');

    // A:200 PLACEHOLDER(payable),B:100 PAID(paid)。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '200.00',
        businessDate: '2026-03-15',
        handler: '经办人A',
        summary: 'A1',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafB.id,
        amount: '100.00',
        businessDate: '2026-06-20',
        handler: '经办人B',
        summary: 'B1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    const result = await customStatistics({ projectId: project.id, budgetYear: 2026 }, adminUser());

    // 汇总:paid=100,payable=200,totalOccupied=300。
    expect(result.summary.paid).toBe('100.00');
    expect(result.summary.payable).toBe('200.00');
    expect(result.summary.totalOccupied).toBe('300.00');
    // 预算 = 600 + 400 = 1000(subject_budgets currentAmount 之和)。
    expect(result.summary.currentBudget).toBe('1000.00');
    // 结余 = 1000 - 300 = 700。
    expect(result.summary.balance).toBe('700.00');
    // 执行率 = 300 / 1000 = 0.3。
    expect(result.summary.executionRate).toBeCloseTo(0.3, 5);
    // 明细列表 2 条。
    expect(result.records.length).toBe(2);
  });

  it('customStatistics: 跨项目(无 projectId)非 admin → 403;admin → 聚合多项目', async () => {
    await seedApprovedProject('CROSS1');
    const { project: p2, leafA: leafA2 } = await seedApprovedProject('CROSS2');

    // 给 p2 加一条记录,跨项目聚合时会被纳入。
    await createRecord(
      p2.id,
      {
        budgetYear: 2026,
        subjectId: leafA2.id,
        amount: '50.00',
        businessDate: '2026-07-01',
        handler: '经办人A',
        summary: 'p2',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    // 非管理员跨项目查询 → 403。
    await expect(customStatistics({}, outsiderUser())).rejects.toMatchObject({ status: 403 });

    // 管理员跨项目:汇总应包含 p1(无记录)+ p2(有 50 paid)。
    const result = await customStatistics({}, adminUser());
    // 至少包含本次新建的两个项目 + 数据库中其他已有项目。
    expect(result.records.length).toBeGreaterThanOrEqual(1);
    const summaryPaid = Number(result.summary.paid);
    expect(summaryPaid).toBeGreaterThanOrEqual(50);
  });

  // ---------------- monthlyHistory(§11.4) ----------------

  it('monthlyHistory: 返回 12 个月;记录按 businessDate 月份归集正确', async () => {
    const { project, leafA } = await seedApprovedProject('MONTH');

    // 3 月:200 PAID(paid)。6 月:150 CONTRACT(payable)。其余月无记录。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '200.00',
        businessDate: '2026-03-10',
        handler: '经办人A',
        summary: 'm3',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '150.00',
        businessDate: '2026-06-25',
        handler: '经办人A',
        summary: 'm6',
        status: BusinessStatus.CONTRACT,
      },
      adminUser(),
    );

    const { months } = await monthlyHistory(project.id, 2026, adminUser());

    // 固定 12 个月。
    expect(months.length).toBe(12);
    expect(months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // 3 月:paid=200,payable=0,totalOccupied=200。
    const mar = months.find((m) => m.month === 3)!;
    expect(mar.paid).toBe('200.00');
    expect(mar.payable).toBe('0.00');
    expect(mar.totalOccupied).toBe('200.00');

    // 6 月:paid=0,payable=150,totalOccupied=150。
    const jun = months.find((m) => m.month === 6)!;
    expect(jun.paid).toBe('0.00');
    expect(jun.payable).toBe('150.00');
    expect(jun.totalOccupied).toBe('150.00');

    // 空月份:全 0。
    const jan = months.find((m) => m.month === 1)!;
    expect(jan.paid).toBe('0.00');
    expect(jan.payable).toBe('0.00');
    expect(jan.totalOccupied).toBe('0.00');
  });

  it('monthlyHistory: 非项目成员 → 403', async () => {
    const { project } = await seedApprovedProject('MONTHPERM');
    await expect(monthlyHistory(project.id, 2026, outsiderUser())).rejects.toMatchObject({
      status: 403,
    });
  });

  // ---------------- crossProjectStatistics(§11.5) ----------------

  it('crossProjectStatistics: 非 admin → 403;admin → 返回逐项目行', async () => {
    const { project: p1, leafA: leafA1 } = await seedApprovedProject('XP1');
    const { project: p2 } = await seedApprovedProject('XP2');

    // p1:100 PAID;p2:无记录。
    await createRecord(
      p1.id,
      {
        budgetYear: 2026,
        subjectId: leafA1.id,
        amount: '100.00',
        businessDate: '2026-04-01',
        handler: '经办人A',
        summary: 'p1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    // 非管理员 → 403。
    await expect(crossProjectStatistics({}, outsiderUser())).rejects.toMatchObject({
      status: 403,
    });

    // 管理员:返回逐项目行。
    const { projects } = await crossProjectStatistics({}, adminUser());
    const row1 = projects.find((r) => r.projectId === p1.id);
    const row2 = projects.find((r) => r.projectId === p2.id);
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    // p1 编制生效后 ProjectBudget.currentAmount = 1000,占用 100。
    expect(row1!.currentBudget).toBe('1000.00');
    expect(row1!.totalOccupied).toBe('100.00');
    expect(row1!.paid).toBe('100.00');
    expect(row1!.balance).toBe('900.00');
    expect(row1!.executionRate).toBeCloseTo(0.1, 5);

    // p2 无记录。
    expect(row2!.currentBudget).toBe('1000.00');
    expect(row2!.totalOccupied).toBe('0.00');
    expect(row2!.balance).toBe('1000.00');
    // 同名科目不合并:行以 projectId 为粒度,p1/p2 各自一行,符合 §11.5。
    expect(projects.filter((r) => r.name === `stat XP1`).length).toBe(1);
    expect(projects.filter((r) => r.name === `stat XP2`).length).toBe(1);
  });
});
