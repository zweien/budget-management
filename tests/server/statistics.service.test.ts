import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, Prisma, UserRole } from '@prisma/client';

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
  balanceStatistics,
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
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });
  const outsiderUser = () => ({ id: outsiderId, role: UserRole.USER });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'admin-stat', role: UserRole.ADMIN },
        { id: outsiderId, name: 'outsider-stat', role: UserRole.USER },
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
    const project = await createProject(
      { code, name: `stat ${suffix}` },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, leafA, leafB };
  }

  // ---------------- crossProjectStatistics:年度口径 ----------------

  it('crossProjectStatistics: 年度视图预算取年度预算——只编总预算未编年度的项目贡献 0', async () => {
    // A:完整编制(2026 年度 1000);B:仅项目总预算 780 万,无任何年度/科目预算。
    const { project: pa } = await seedApprovedProject('XANNUAL');
    const projectB = await createProject(
      { code: `STAT-XTOTAL-${uuidv7().slice(0, 8)}`, name: 'stat xtotal' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(projectB.id);
    await prisma.projectBudget.updateMany({
      where: { projectId: projectB.id },
      data: {
        initialAmount: new Prisma.Decimal('7800000'),
        currentAmount: new Prisma.Decimal('7800000'),
      },
    });

    // 年度视图:预算 = 年度预算;B 未编年度 → 0。
    const { projects } = await crossProjectStatistics({ year: 2026 }, adminUser());
    const rowA = projects.find((r) => r.projectId === pa.id)!;
    const rowB = projects.find((r) => r.projectId === projectB.id)!;
    expect(rowA.currentBudget).toBe('1000.00');
    expect(rowB.currentBudget).toBe('0.00');
    expect(rowB.totalOccupied).toBe('0.00');

    // 未指定年度:仍为项目层总预算口径,B 显示 7800000。
    const all = await crossProjectStatistics({}, adminUser());
    const rowBAll = all.projects.find((r) => r.projectId === projectB.id)!;
    expect(rowBAll.currentBudget).toBe('7800000.00');
  });

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
    // creatorName(0.14 筛选扩展):录入人姓名随明细带出。
    for (const r of result.records) {
      expect(r.creatorName).toBe('admin-stat');
    }
  });

  it('customStatistics: 跨项目(无 projectId)普通用户可查(v0.3.0 全局只读)', async () => {
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

    // 普通用户跨项目查询:放行,聚合包含 p2 的 50 paid。
    const result = await customStatistics({}, outsiderUser());
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

  it('monthlyHistory: 非项目成员也可查看(全局只读)', async () => {
    const { project } = await seedApprovedProject('MONTHPERM');
    const result = await monthlyHistory(project.id, 2026, outsiderUser());
    expect(result.months).toHaveLength(12);
  });

  // ---------------- crossProjectStatistics(§11.5) ----------------

  it('crossProjectStatistics: 普通用户可查(全局只读),返回逐项目行', async () => {
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

    // 普通用户:返回逐项目行(v0.3.0 全局只读)。
    const { projects } = await crossProjectStatistics({}, outsiderUser());
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

  // ---------------- balanceStatistics(经费余额,总预算口径) ----------------

  it('balanceStatistics: 模糊匹配科目名称 → 项目×科目行;总预算口径结余正确', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('BAL1');

    // A:200 PAID + 100 CONTRACT;B:50 PAID。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '200.00',
        businessDate: '2026-03-15',
        handler: '经办人A',
        summary: 'A1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '100.00',
        businessDate: '2026-04-15',
        handler: '经办人A',
        summary: 'A2',
        status: BusinessStatus.CONTRACT,
      },
      adminUser(),
    );
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafB.id,
        amount: '50.00',
        businessDate: '2026-05-15',
        handler: '经办人B',
        summary: 'B1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    // 模糊匹配"叶A":只命中 A(叶),B 不出现。
    const result = await balanceStatistics({ subject: '叶A' }, adminUser());
    const rows = result.rows.filter((r) => r.projectId === project.id);
    expect(rows.length).toBe(1);
    const rowA = rows[0];
    // 总预算 = SubjectTotalBudget.currentAmount = 600。
    expect(rowA.totalBudget).toBe('600.00');
    expect(rowA.paid).toBe('200.00');
    expect(rowA.payable).toBe('100.00');
    expect(rowA.totalOccupied).toBe('300.00');
    // 总结余 = 600 - 300 = 300(总预算口径,非年度口径差异场景同值)。
    expect(rowA.balance).toBe('300.00');
    expect(rowA.executionRate).toBeCloseTo(0.5, 5);
    // 未选年度 → 年度列为 null。
    expect(rowA.yearBudget).toBeNull();
    // 合计与单行一致(限定项目,避免库中其他项目同名科目干扰)。
    const projTotal = await balanceStatistics(
      { subject: '叶A', projectId: project.id },
      adminUser(),
    );
    expect(projTotal.total.balance).toBe('300.00');
  });

  it('balanceStatistics: 匹配非叶科目 → 行含下级汇总;合计按去重叶集合不重复计数', async () => {
    const { project, leafA } = await seedApprovedProject('BAL2');

    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '700.00',
        businessDate: '2026-03-15',
        handler: '经办人A',
        summary: 'A1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    // "根"命中非叶 ROOT → 一行,指标 = A+B 汇总。
    const result = await balanceStatistics({ subject: '根' }, adminUser());
    const rootRow = result.rows.find((r) => r.projectId === project.id);
    expect(rootRow).toBeDefined();
    expect(rootRow!.isLeaf).toBe(false);
    expect(rootRow!.totalBudget).toBe('1000.00'); // 600 + 400
    expect(rootRow!.totalOccupied).toBe('700.00');
    expect(rootRow!.balance).toBe('300.00');
    // 合计 = 去重叶集合(A+B),不因 ROOT 行含 A 而重复计 A 的占用。
    const projTotal = await balanceStatistics(
      { subject: '根', projectId: project.id },
      adminUser(),
    );
    expect(projTotal.total.totalBudget).toBe('1000.00');
    expect(projTotal.total.totalOccupied).toBe('700.00');
  });

  it('balanceStatistics: 编号模糊匹配 + onlyNegative 过滤 + 年度口径列', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('BAL3');

    // A 超支:占用 700 > 总预算 600 → 结余 -100。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '700.00',
        businessDate: '2026-03-15',
        handler: '经办人A',
        summary: 'A1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    // B 正常:占用 100 < 400 → 结余 300。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafB.id,
        amount: '100.00',
        businessDate: '2026-06-15',
        handler: '经办人B',
        summary: 'B1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    // 编号 'A' 模糊命中 A(叶);按年度 2026 查询 → 年度列回填。
    const withYear = await balanceStatistics({ subject: 'A', year: 2026 }, adminUser());
    const rowA = withYear.rows.find((r) => r.projectId === project.id)!;
    expect(rowA.subjectCode).toBe('A');
    expect(rowA.balance).toBe('-100.00');
    // 年度口径:年度预算 600,年度占用 700,年度结余 -100。
    expect(rowA.yearBudget).toBe('600.00');
    expect(rowA.yearOccupied).toBe('700.00');
    expect(rowA.yearBalance).toBe('-100.00');

    // onlyNegative:B(结余 300)被过滤,只剩 A。
    const negOnly = await balanceStatistics(
      { projectId: project.id, onlyNegative: true },
      adminUser(),
    );
    const codes = negOnly.rows.map((r) => r.subjectCode);
    expect(codes).toContain('A');
    expect(codes).not.toContain('B');
    expect(negOnly.total.balance).toBe('-100.00');
  });

  it('balanceStatistics: 无匹配科目 → 空结果;跨项目普通用户可查', async () => {
    await seedApprovedProject('BAL4');
    const none = await balanceStatistics({ subject: '不存在的科目xyz' }, adminUser());
    expect(none.rows.length).toBe(0);
    expect(none.hitProjects).toBe(0);
    expect(none.total.totalOccupied).toBe('0.00');

    // 普通用户全局只读可查。
    const asOutsider = await balanceStatistics({}, outsiderUser());
    expect(asOutsider.rows.length).toBeGreaterThanOrEqual(0);
  });

  // ---------------- customStatistics 科目模糊(v0.4.1) ----------------

  it('customStatistics: subject 模糊匹配(名称) → 命中科目明细;非叶匹配展开为叶集合', async () => {
    const { project, leafA } = await seedApprovedProject('CSUB');

    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '200.00',
        businessDate: '2026-03-15',
        handler: '经办人A',
        summary: 'A1',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    // 名称模糊"叶B":不命中 A → 无记录。
    const onlyB = await customStatistics({ projectId: project.id, subject: '叶B' }, adminUser());
    expect(onlyB.records.length).toBe(0);
    expect(onlyB.summary.totalOccupied).toBe('0.00');

    // 非叶"根"匹配 → 展开为 A+B,记录含 A1。
    const viaRoot = await customStatistics({ projectId: project.id, subject: '根' }, adminUser());
    expect(viaRoot.records.length).toBe(1);
    expect(viaRoot.records[0].summary).toBe('A1');

    // 编号模糊 'A' → 命中叶 A。
    const viaCode = await customStatistics({ projectId: project.id, subject: 'A' }, adminUser());
    expect(viaCode.records.length).toBe(1);

    // 完全不匹配 → 空结果。
    const none = await customStatistics(
      { projectId: project.id, subject: '不存在xyz' },
      adminUser(),
    );
    expect(none.records.length).toBe(0);
    expect(none.summary.currentBudget).toBe('0.00');
  });
});
