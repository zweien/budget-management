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
import { createRecord, voidRecord } from '@/server/services/businessRecord.service';
import {
  balanceStatistics,
  crossProjectStatistics,
  customStatistics,
  customStatisticsFacets,
  monthlyHistory,
  riskSummary,
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

  // ---------------- riskSummary:首页风险预警(跨项目负结余科目) ----------------

  it('riskSummary: 一次取回全部项目负结余科目(仅超支科目,作废不计,最负在前)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('RISK1');
    const { project: p2, leafA: leafA2 } = await seedApprovedProject('RISK2');

    // p1/leafA(2026 年度预算 600):记录 700 → 负结余 -100;作废 5000 不计入。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '700.00',
        businessDate: '2026-03-01',
        handler: '经办',
        summary: 'over',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    const voided = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '5000.00',
        businessDate: '2026-03-02',
        handler: '经办',
        summary: 'void-me',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    await voidRecord(voided.record.id, '作废', adminUser());
    // p1/leafB(预算 400):记录 800 → 负结余 -400(比 leafA 更负,排序应在前)。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafB.id,
        amount: '800.00',
        businessDate: '2026-03-03',
        handler: '经办',
        summary: 'worse',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    // p2/leafA2:记录 50 → 不超支。
    await createRecord(
      p2.id,
      {
        budgetYear: 2026,
        subjectId: leafA2.id,
        amount: '50.00',
        businessDate: '2026-03-04',
        handler: '经办',
        summary: 'ok2',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    const { rows } = await riskSummary({ year: 2026 }, adminUser());
    // 断言收敛到本项目(共享库中其他用例可能产生各自的风险行)。
    const own = rows.filter((r) => r.projectId === project.id);
    expect(own).toHaveLength(2);
    // 排序:结余升序(最负在前)——leafB(-400)在 leafA(-100)之前。
    expect(own[0].subjectCode).toBe('B');
    expect(own[0].budget).toBe('400.00');
    expect(own[0].occupied).toBe('800.00');
    expect(own[0].balance).toBe('-400.00');
    expect(own[1].subjectCode).toBe('A');
    expect(own[1].balance).toBe('-100.00');

    // 其他年度本项目无风险行。
    const otherYear = await riskSummary({ year: 2027 }, adminUser());
    expect(otherYear.rows.some((r) => r.projectId === project.id)).toBe(false);

    // 已归档项目排除(旧口径经 /api/projects 默认不含归档,保持一致)。
    await prisma.project.update({
      where: { id: project.id },
      data: { archivedAt: new Date() },
    });
    const afterArchive = await riskSummary({ year: 2026 }, adminUser());
    expect(afterArchive.rows.some((r) => r.projectId === project.id)).toBe(false);
    await prisma.project.update({
      where: { id: project.id },
      data: { archivedAt: null },
    });
  });

  it('riskSummary: 未编制年度预算但发生占用的科目按 0 预算判定超支', async () => {
    const { project, leafA } = await seedApprovedProject('RISK3');
    // 删除 leafA 的 2026 科目年度预算 → 预算 0,任何占用都是负结余。
    await prisma.subjectBudget.deleteMany({
      where: { projectId: project.id, year: 2026, subjectId: leafA.id },
    });
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '120.00',
        businessDate: '2026-04-01',
        handler: '经办',
        summary: 'no-budget',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    const { rows } = await riskSummary({ year: 2026 }, adminUser());
    const row = rows.find((r) => r.projectId === project.id && r.subjectCode === 'A');
    expect(row).toBeDefined();
    expect(row!.budget).toBe('0.00');
    expect(row!.balance).toBe('-120.00');
    expect(row!.executionRate).toBeNull();
  });

  // ---------------- customStatistics v0.15 扩展:服务端筛选/排序/分页 ----------------

  it('customStatistics: 服务端筛选/排序/分页 + stats(全局录入页驱动)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('CSP');
    const mk = (o: Record<string, unknown>) =>
      createRecord(
        project.id,
        {
          budgetYear: 2026,
          subjectId: leafA.id,
          amount: '100.00',
          businessDate: '2026-05-01',
          handler: '甲',
          summary: 'csp-a',
          remark: 'csp-note-a',
          status: BusinessStatus.PAID,
          ...o,
        } as never,
        adminUser(),
      );
    await mk({});
    await mk({
      subjectId: leafB.id,
      amount: '200.00',
      businessDate: '2026-05-02',
      handler: '乙',
      summary: 'csp-b',
      remark: 'csp-note-b',
      status: BusinessStatus.CONTRACT,
    });
    const r3 = await mk({
      budgetYear: 2027,
      amount: '300.00',
      businessDate: '2027-05-01',
      summary: 'csp-c',
      remark: 'csp-note-c',
    });

    // remark contains(唯一前缀,免共享库串扰)。
    const byRemark = await customStatistics({ remark: 'csp-note-b' }, adminUser());
    expect(byRemark.total).toBe(1);
    expect(byRemark.records[0]?.summary).toBe('csp-b');

    // 年度 + 状态集合组合。
    const f2 = await customStatistics(
      { projectId: project.id, budgetYear: 2026, statuses: [BusinessStatus.CONTRACT] },
      adminUser(),
    );
    expect(f2.records).toHaveLength(1);
    expect(f2.records[0]?.summary).toBe('csp-b');

    // 分页 + 排序(businessDate asc)。
    const pg = await customStatistics(
      {
        projectId: project.id,
        sort: { field: 'businessDate', dir: 'asc' },
        page: 1,
        pageSize: 2,
      },
      adminUser(),
    );
    expect(pg.records).toHaveLength(2);
    expect(pg.total).toBe(3);
    expect(pg.records[0]?.summary).toBe('csp-a');
    expect(pg.stats.totalCount).toBe(3);
    expect(pg.stats.validCount).toBe(3);
    expect(pg.stats.amountSum).toBe('600.00');
    const pg2 = await customStatistics(
      {
        projectId: project.id,
        sort: { field: 'businessDate', dir: 'asc' },
        page: 2,
        pageSize: 2,
      },
      adminUser(),
    );
    expect(pg2.records).toHaveLength(1);
    expect(pg2.records[0]?.summary).toBe('csp-c');

    // 作废:不计入 stats 金额/有效数,但计入总数。
    await voidRecord(r3.record.id, '作废', adminUser());
    const after = await customStatistics(
      { projectId: project.id, includeVoid: true, page: 1, pageSize: 2 },
      adminUser(),
    );
    expect(after.stats.totalCount).toBe(3);
    expect(after.stats.validCount).toBe(2);
    expect(after.stats.amountSum).toBe('300.00');

    // 录入人集合筛选(默认排除作废 → 仅剩两条有效)。
    const byCreator = await customStatistics(
      { projectId: project.id, creatorNames: ['admin-stat'] },
      adminUser(),
    );
    expect(byCreator.total).toBe(2);
  });

  it('customStatistics: 无完成日期 / 金额区间筛选', async () => {
    const { project, leafA } = await seedApprovedProject('CSF2');
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '150.00',
        businessDate: '2026-06-01',
        handler: '丙',
        summary: 'csf2-a',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '450.00',
        businessDate: '2026-06-02',
        handler: '丙',
        summary: 'csf2-b',
        status: BusinessStatus.PAID,
        completedDate: '2026-07-01',
      } as never,
      adminUser(),
    );

    const empty = await customStatistics(
      { projectId: project.id, completedDateEmpty: true },
      adminUser(),
    );
    expect(empty.total).toBe(1);
    expect(empty.records[0]?.summary).toBe('csf2-a');

    const ranged = await customStatistics(
      { projectId: project.id, amountFrom: '400' },
      adminUser(),
    );
    expect(ranged.total).toBe(1);
    expect(ranged.records[0]?.summary).toBe('csf2-b');
  });

  it('customStatisticsFacets: 候选清单(年度/经办人/录入人/叶科目名)', async () => {
    const { project: p2, leafA } = await seedApprovedProject('CSF3B');
    await createRecord(
      p2.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '10.00',
        businessDate: '2026-08-01',
        handler: 'facet-甲',
        summary: 'facet',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    const facets = await customStatisticsFacets([p2.id], adminUser());
    expect(facets.years).toContain(2026);
    expect(facets.handlerNames).toContain('facet-甲');
    expect(facets.creatorNames).toContain('admin-stat');
    expect(facets.subjectNames).toEqual(expect.arrayContaining(['叶A', '叶B']));
  });
});
