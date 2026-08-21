import { BusinessStatus, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { D, ZERO, fromStored, sumAmounts } from '@/lib/decimal';
import { computeOccupancy, executionRate } from '@/lib/budget';

/**
 * §11.3-11.5 统计分析服务。
 *
 * 全部金额字段输出为 decimal 字符串(.toFixed(2),保留尾零)以适配 §5 JSON 传输;
 * executionRate 保持 number | null(便于前端直接渲染百分比)。
 *
 * 占用口径与 ledger/businessRecord 一致:复用 computeOccupancy。
 * - paid = 状态为 PAID 的有效记录金额合计。
 * - payable = 状态为 PLACEHOLDER/CONTRACT/FINANCE_APPROVAL 的有效记录金额合计。
 * - totalOccupied = paid + payable。
 * - 作废记录不计入。
 */

// ---------------- 自定义统计(§11.3) ----------------

/** §11.3 自定义统计组合筛选条件。 */
export interface CustomStatisticsFilters {
  /** 项目 ID(指定后按该项目过滤;否则跨项目,所有登录用户可查)。 */
  projectId?: string;
  /** 预算年度。 */
  budgetYear?: number;
  /**
   * 预算科目模糊检索:名称/编号 contains(不区分大小写),跨项目命中;
   * 匹配到非叶科目时按其全部后代叶展开。缺省 = 不过滤。
   * (v0.4.1 前为 subjectId 精确 UUID,已替换。)
   */
  subject?: string;
  /** 业务状态。 */
  status?: BusinessStatus;
  /** 业务发生日期范围起(ISO yyyy-mm-dd,含)。 */
  businessDateFrom?: string;
  /** 业务发生日期范围止(ISO yyyy-mm-dd,含)。 */
  businessDateTo?: string;
  /** 经办人(模糊匹配)。 */
  handler?: string;
  /** 是否包含作废记录(默认 false)。 */
  includeVoid?: boolean;
}

/** §11.3 汇总(全部金额 2 位小数字符串;executionRate 为 number|null)。 */
export interface CustomStatisticsSummary {
  /** 当前预算(筛选项目/年度对应的 subject_budgets.currentAmount 之和)。 */
  currentBudget: string;
  /** 已支出(PAID)。 */
  paid: string;
  /** 应付未付(非 PAID)。 */
  payable: string;
  /** 总占用。 */
  totalOccupied: string;
  /** 结余 = currentBudget - totalOccupied。 */
  balance: string;
  /** 执行率 = totalOccupied ÷ currentBudget(currentBudget=0 → null)。 */
  executionRate: number | null;
}

/** §11.3 业务明细行(join 科目,便于前端展示科目编码/名称)。 */
export type CustomStatisticsRecord = Prisma.BusinessRecordGetPayload<{
  include: { subject: { select: { id: true; code: true; name: true } } };
}>;

export interface CustomStatisticsResult {
  summary: CustomStatisticsSummary;
  records: CustomStatisticsRecord[];
}

/**
 * §11.3 自定义统计。
 *
 * 权限:
 * - 若指定 projectId:`requirePermission(user, 'project:view', projectId)`(含项目范围)。
 * - 否则(跨项目查询):v0.3.0 起所有登录用户可查(全局只读)。
 *
 * 实现:
 * - 按 filters 构建 Prisma where 查询 business_records(按 businessDate desc 排序)。
 * - 占用走 computeOccupancy(对所查记录全集)。
 * - 预算:取筛选项目/年度对应的 subject_budgets.currentAmount 之和;无年度/项目时为 0。
 *   (跨项目场景下取所有匹配项目的 subject_budgets 汇总。)
 * - balance / executionRate 同 ledger 口径。
 */
export async function customStatistics(
  filters: CustomStatisticsFilters,
  user: Pick<User, 'id' | 'role'>,
): Promise<CustomStatisticsResult> {
  // 1) 权限:v0.3.0 起普通用户全局只读,跨项目查询对所有登录用户开放。
  if (filters.projectId) {
    await requirePermission(user, 'project:view', filters.projectId);
  }

  // 2) 科目模糊检索:取项目(或全部)科目树,contains 匹配后展开为叶 ID 集合。
  //    无匹配 → 直接返回空结果(不再查记录)。
  const subjectWhere: Prisma.BudgetSubjectWhereInput = filters.projectId
    ? { projectId: filters.projectId }
    : {};
  const allSubjects = await prisma.budgetSubject.findMany({ where: subjectWhere });
  let subjectLeafIds: Set<string> | undefined;
  if (filters.subject) {
    subjectLeafIds = matchSubjects(allSubjects, filters.subject).leafIds;
    if (subjectLeafIds.size === 0) {
      return {
        summary: {
          currentBudget: '0.00',
          paid: '0.00',
          payable: '0.00',
          totalOccupied: '0.00',
          balance: '0.00',
          executionRate: null,
        },
        records: [],
      };
    }
  }

  // 3) 构建 business_records 查询条件。
  const where: Prisma.BusinessRecordWhereInput = {};
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.budgetYear !== undefined) where.budgetYear = filters.budgetYear;
  if (subjectLeafIds) where.subjectId = { in: [...subjectLeafIds] };
  if (filters.status) where.status = filters.status;
  if (filters.handler) where.handler = { contains: filters.handler, mode: 'insensitive' };
  if (!filters.includeVoid) where.isVoid = false;
  if (filters.businessDateFrom || filters.businessDateTo) {
    where.businessDate = {};
    if (filters.businessDateFrom) {
      where.businessDate.gte = parseDate(filters.businessDateFrom, 'businessDateFrom');
    }
    if (filters.businessDateTo) {
      where.businessDate.lte = parseDate(filters.businessDateTo, 'businessDateTo');
    }
  }

  const records = await prisma.businessRecord.findMany({
    where,
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
    include: { subject: { select: { id: true, code: true, name: true } } },
  });

  // 4) 占用(computeOccupancy 对所查记录全集,内部已自检 isVoid)。
  const occ = computeOccupancy({
    records: records.map((r) => ({ amount: r.amount, status: r.status, isVoid: r.isVoid })),
  });

  // 5) 预算:筛选项目/年度对应的 subject_budgets.currentAmount 之和。
  //    跨项目(无 projectId)且未指定年度时,预算口径无意义,置 0。
  const sbWhere: Prisma.SubjectBudgetWhereInput = {};
  if (filters.projectId) sbWhere.projectId = filters.projectId;
  if (filters.budgetYear !== undefined) sbWhere.year = filters.budgetYear;
  const subjectBudgets = await prisma.subjectBudget.findMany({ where: sbWhere });
  const currentBudget = sumAmounts(subjectBudgets.map((sb) => fromStored(sb.currentAmount)));

  // 6) 结余 / 执行率。
  const balance = currentBudget.minus(occ.totalOccupied);

  return {
    summary: {
      currentBudget: currentBudget.toFixed(2),
      paid: occ.paid.toFixed(2),
      payable: occ.payable.toFixed(2),
      totalOccupied: occ.totalOccupied.toFixed(2),
      balance: balance.toFixed(2),
      executionRate: executionRate(occ.totalOccupied, currentBudget),
    },
    records,
  };
}

// ---------------- 月度历史统计(§11.4) ----------------

/** §11.4 单个月度汇总。 */
export interface MonthlyHistoryBucket {
  /** 月份 1-12。 */
  month: number;
  paid: string;
  payable: string;
  totalOccupied: string;
}

export interface MonthlyHistoryResult {
  /** 固定 12 个月(1-12),无记录的月份各字段为 '0.00'。 */
  months: MonthlyHistoryBucket[];
}

/**
 * §11.4 月度历史统计。
 *
 * - 权限:project:view + 项目范围。
 * - 查该项目该年度非作废记录(动态重算,§11.4:直接查 live,不快照)。
 * - 按业务发生日期(businessDate)归月(getUTCMonth()+1,因 businessDate 存为 UTC Date)。
 * - 对每个月的记录集单独 computeOccupancy,得到 paid/payable/totalOccupied。
 * - 返回固定 12 个月(1-12),空月份各字段为 '0.00'。
 */
export async function monthlyHistory(
  projectId: string,
  year: number,
  user: Pick<User, 'id' | 'role'>,
): Promise<MonthlyHistoryResult> {
  await requirePermission(user, 'project:view', projectId);

  const records = await prisma.businessRecord.findMany({
    where: { projectId, budgetYear: year, isVoid: false },
  });

  // 按月份分桶(1-12)。businessDate 在 §8 存为 UTC 0 点 Date,用 UTC 月份避免时区漂移。
  const buckets: Record<number, typeof records> = {};
  for (let m = 1; m <= 12; m++) buckets[m] = [];
  for (const r of records) {
    const m = r.businessDate.getUTCMonth() + 1;
    buckets[m].push(r);
  }

  const months: MonthlyHistoryBucket[] = [];
  for (let m = 1; m <= 12; m++) {
    const occ = computeOccupancy({
      records: buckets[m].map((r) => ({ amount: r.amount, status: r.status, isVoid: r.isVoid })),
    });
    months.push({
      month: m,
      paid: occ.paid.toFixed(2),
      payable: occ.payable.toFixed(2),
      totalOccupied: occ.totalOccupied.toFixed(2),
    });
  }

  return { months };
}

// ---------------- 跨项目统计(§11.5) ----------------

/** §11.5 跨项目统计入参。 */
export interface CrossProjectStatisticsFilters {
  /** 可选年度过滤(影响占用计算);缺省则查项目全部年度记录。 */
  year?: number;
}

/** §11.5 单个项目汇总行。 */
export interface CrossProjectStatisticsRow {
  projectId: string;
  name: string;
  /** 总预算 = ProjectBudget.currentAmount。 */
  currentBudget: string;
  /** 总占用 = 项目有效记录占用合计。 */
  totalOccupied: string;
  /** 已支出(PAID)。 */
  paid: string;
  /** 结余。 */
  balance: string;
  /** 执行率。 */
  executionRate: number | null;
}

export interface CrossProjectStatisticsResult {
  projects: CrossProjectStatisticsRow[];
}

/**
 * §11.5 跨项目统计。
 *
 * - 权限:所有登录用户(全局只读)。
 * - 对管理员可见的全部项目(非归档)逐项汇总:
 *   - 总预算 = ProjectBudget.currentAmount(项目层面,§11.5)。
 *   - 总占用 = 项目有效记录(可按 year 过滤)的占用合计。
 *   - 同名科目不合并(§11.5:各项目科目树独立;此处只在项目层面聚合,自然不跨项目合并)。
 * - balance / executionRate 同 ledger 口径。
 */
export async function crossProjectStatistics(
  filters: CrossProjectStatisticsFilters,
  user: Pick<User, 'id' | 'role'>,
): Promise<CrossProjectStatisticsResult> {
  // v0.3.0 起普通用户全局只读 → 跨项目统计对所有登录用户开放(只读聚合)。
  await requirePermission(user, 'project:view');

  // 1) 全部项目(非归档)逐项汇总。
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const projectIds = projects.map((p) => p.id);

  // 2) 一次性查预算 + 记录,再按项目分组,避免 N+1。
  const [projectBudgets, records] = await Promise.all([
    prisma.projectBudget.findMany({ where: { projectId: { in: projectIds } } }),
    prisma.businessRecord.findMany({
      where: {
        projectId: { in: projectIds },
        isVoid: false,
        ...(filters.year !== undefined ? { budgetYear: filters.year } : {}),
      },
    }),
  ]);

  const budgetByProject = new Map(projectBudgets.map((pb) => [pb.projectId, pb]));
  const recordsByProject = new Map<string, typeof records>();
  for (const r of records) {
    const list = recordsByProject.get(r.projectId) ?? [];
    list.push(r);
    recordsByProject.set(r.projectId, list);
  }

  // 3) 逐项目计算。
  const rows: CrossProjectStatisticsRow[] = projects.map((p) => {
    const pb = budgetByProject.get(p.id);
    const currentBudget: D = pb ? fromStored(pb.currentAmount) : ZERO;
    const occ = computeOccupancy({
      records: (recordsByProject.get(p.id) ?? []).map((r) => ({
        amount: r.amount,
        status: r.status,
        isVoid: r.isVoid,
      })),
    });
    const balance = currentBudget.minus(occ.totalOccupied);
    return {
      projectId: p.id,
      name: p.name,
      currentBudget: currentBudget.toFixed(2),
      totalOccupied: occ.totalOccupied.toFixed(2),
      paid: occ.paid.toFixed(2),
      balance: balance.toFixed(2),
      executionRate: executionRate(occ.totalOccupied, currentBudget),
    };
  });

  return { projects: rows };
}

// ---------------- 经费余额统计 ----------------

/** 经费余额统计入参。 */
export interface BalanceStatisticsFilters {
  /**
   * 科目模糊检索:名称/编号 contains(不区分大小写)。
   * 空 = 全部科目(仅列叶科目行);匹配到非叶科目时该行按后代叶汇总。
   */
  subject?: string;
  /** 项目 ID(可选,默认全部非归档项目)。 */
  projectId?: string;
  /** 年度(可选;选定后行内追加年度预算/占用/结余三列)。 */
  year?: number;
  /** 仅看总结余 < 0(按总预算口径)。 */
  onlyNegative?: boolean;
}

/** 经费余额单行:项目 × 科目。 */
export interface BalanceRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  isLeaf: boolean;
  /** 科目总预算(SubjectTotalBudget.currentAmount;非叶 = 后代叶合计)。 */
  totalBudget: string;
  paid: string;
  payable: string;
  totalOccupied: string;
  /** 总结余 = 科目总预算 − 累计总占用。 */
  balance: string;
  executionRate: number | null;
  /** 以下三项仅 filters.year 选定时非 null(年度口径)。 */
  yearBudget: string | null;
  yearOccupied: string | null;
  yearBalance: string | null;
}

export interface BalanceStatisticsResult {
  /** 命中项目数 / 命中科目数(行数)。 */
  hitProjects: number;
  hitSubjects: number;
  rows: BalanceRow[];
  /** 合计(按命中科目的去重叶集合计算,避免父子行重叠重复计数)。 */
  total: Omit<
    BalanceRow,
    | 'projectId'
    | 'projectCode'
    | 'projectName'
    | 'subjectId'
    | 'subjectCode'
    | 'subjectName'
    | 'isLeaf'
  >;
}

/** 科目匹配结果:rows = 匹配到的科目(行),leafIds = 展开后的去重叶集合。 */
interface SubjectMatch {
  rows: {
    id: string;
    code: string;
    name: string;
    isLeaf: boolean;
    /** 该行覆盖的叶科目 ID(叶 = 自身;非叶 = 全部后代叶)。 */
    leafIds: string[];
  }[];
  leafIds: Set<string>;
}

/**
 * 科目模糊匹配:名称/编号 contains(不区分大小写)。
 * - query 为空 → 不匹配任何行,leafIds 为空集(调用方据此决定"全部"语义)。
 * - 匹配到叶 → 该行为叶;匹配到非叶 → 行指标按其全部后代叶汇总。
 */
function matchSubjects(
  subjects: { id: string; code: string; name: string; parentId: string | null; isLeaf: boolean }[],
  query: string,
): SubjectMatch {
  const q = query.trim().toLowerCase();
  if (!q) return { rows: [], leafIds: new Set() };
  const byId = new Map(subjects.map((s) => [s.id, s]));

  /** 收集科目子树的全部叶 ID。 */
  const collectLeaves = (rootId: string, out: string[]): void => {
    const stack = [rootId];
    while (stack.length) {
      const cur = byId.get(stack.pop()!);
      if (!cur) continue;
      if (cur.isLeaf) {
        out.push(cur.id);
        continue;
      }
      for (const s of subjects) if (s.parentId === cur.id) stack.push(s.id);
    }
  };

  const rows: SubjectMatch['rows'] = [];
  const leafIds = new Set<string>();
  for (const s of subjects) {
    if (!s.name.toLowerCase().includes(q) && !s.code.toLowerCase().includes(q)) continue;
    const leaves: string[] = [];
    if (s.isLeaf) leaves.push(s.id);
    else collectLeaves(s.id, leaves);
    rows.push({ id: s.id, code: s.code, name: s.name, isLeaf: s.isLeaf, leafIds: leaves });
    for (const id of leaves) leafIds.add(id);
  }
  return { rows, leafIds };
}

/**
 * 经费余额统计(总预算口径:SubjectTotalBudget.currentAmount − 累计占用)。
 *
 * - 权限:所有登录用户(全局只读);指定 projectId 时校验 project:view。
 * - 行 = 项目 × 科目(命中科目;无匹配行时按"全部叶科目"列出)。
 * - 占用口径与台账一致:四态全占(paid + payable),作废不计。
 * - 无预算/未生效项目照常显示(预算 0、结余为负即风险信号)。
 * - 合计行基于去重叶集合,父子行同时命中不重复计数。
 */
export async function balanceStatistics(
  filters: BalanceStatisticsFilters,
  user: Pick<User, 'id' | 'role'>,
): Promise<BalanceStatisticsResult> {
  if (filters.projectId) {
    await requirePermission(user, 'project:view', filters.projectId);
  } else {
    await requirePermission(user, 'project:view');
  }

  // 1) 项目与科目树。
  const projects = filters.projectId
    ? await prisma.project.findMany({ where: { id: filters.projectId, archivedAt: null } })
    : await prisma.project.findMany({ where: { archivedAt: null } });
  const projectIds = projects.map((p) => p.id);
  const empty: BalanceStatisticsResult = {
    hitProjects: 0,
    hitSubjects: 0,
    rows: [],
    total: {
      totalBudget: '0.00',
      paid: '0.00',
      payable: '0.00',
      totalOccupied: '0.00',
      balance: '0.00',
      executionRate: null,
      yearBudget: null,
      yearOccupied: null,
      yearBalance: null,
    },
  };
  if (projectIds.length === 0) return empty;

  const allSubjects = await prisma.budgetSubject.findMany({
    where: { projectId: { in: projectIds } },
  });

  // 2) 预算 + 记录一次性取齐(全量非作废,跨年度),按 项目×科目 分组。
  const [totalBudgets, records, subjectBudgets] = await Promise.all([
    prisma.subjectTotalBudget.findMany({ where: { projectId: { in: projectIds } } }),
    prisma.businessRecord.findMany({
      where: { projectId: { in: projectIds }, isVoid: false },
    }),
    filters.year !== undefined
      ? prisma.subjectBudget.findMany({
          where: { projectId: { in: projectIds }, year: filters.year },
        })
      : Promise.resolve([]),
  ]);

  const stbByProjectSubject = new Map(
    totalBudgets.map((t) => [`${t.projectId}|${t.subjectId}`, t]),
  );
  const sbByProjectSubject = new Map(
    subjectBudgets.map((t) => [`${t.projectId}|${t.subjectId}`, t]),
  );

  interface OccAgg {
    paid: D;
    payable: D;
    yearPaid: D;
    yearPayable: D;
  }
  const occByProjectSubject = new Map<string, OccAgg>();
  const zeroAgg = (): OccAgg => ({ paid: ZERO, payable: ZERO, yearPaid: ZERO, yearPayable: ZERO });
  for (const r of records) {
    const key = `${r.projectId}|${r.subjectId}`;
    const agg = occByProjectSubject.get(key) ?? zeroAgg();
    const amount = fromStored(r.amount);
    if (r.status === 'PAID') agg.paid = agg.paid.plus(amount);
    else agg.payable = agg.payable.plus(amount);
    if (filters.year !== undefined && r.budgetYear === filters.year) {
      if (r.status === 'PAID') agg.yearPaid = agg.yearPaid.plus(amount);
      else agg.yearPayable = agg.yearPayable.plus(amount);
    }
    occByProjectSubject.set(key, agg);
  }

  // 3) 逐项目匹配科目 → 行;同时累计去重叶集合(合计用)。
  const byProject = new Map<string, typeof allSubjects>();
  for (const s of allSubjects) {
    const list = byProject.get(s.projectId) ?? [];
    list.push(s);
    byProject.set(s.projectId, list);
  }

  const rows: BalanceRow[] = [];
  const dedupLeafKeys = new Set<string>();
  for (const p of projects) {
    const subjects = byProject.get(p.id) ?? [];
    // 无查询 → 全部叶科目;有查询 → 匹配科目(含非叶汇总行)。
    const matchedRows =
      filters.subject && filters.subject.trim()
        ? matchSubjects(subjects, filters.subject).rows
        : subjects
            .filter((s) => s.isLeaf)
            .map((s) => ({ id: s.id, code: s.code, name: s.name, isLeaf: true, leafIds: [s.id] }));

    for (const m of matchedRows) {
      let totalBudget = ZERO;
      let paid = ZERO;
      let payable = ZERO;
      let yearBudget: D | null = null;
      let yearPaid = ZERO;
      let yearPayable = ZERO;
      for (const leafId of m.leafIds) {
        const stb = stbByProjectSubject.get(`${p.id}|${leafId}`);
        if (stb) totalBudget = totalBudget.plus(fromStored(stb.currentAmount));
        const occ = occByProjectSubject.get(`${p.id}|${leafId}`);
        if (occ) {
          paid = paid.plus(occ.paid);
          payable = payable.plus(occ.payable);
          yearPaid = yearPaid.plus(occ.yearPaid);
          yearPayable = yearPayable.plus(occ.yearPayable);
        }
        if (filters.year !== undefined) {
          yearBudget = (yearBudget ?? ZERO).plus(
            fromStored(sbByProjectSubject.get(`${p.id}|${leafId}`)?.currentAmount ?? '0'),
          );
        }
      }
      const totalOccupied = paid.plus(payable);
      const balance = totalBudget.minus(totalOccupied);
      // onlyNegative 过滤须在计入合计之前:被过滤行的叶不进去重集合。
      if (filters.onlyNegative && !balance.isNegative()) continue;
      for (const leafId of m.leafIds) dedupLeafKeys.add(`${p.id}|${leafId}`);

      const yearOccupied = yearPaid.plus(yearPayable);
      rows.push({
        projectId: p.id,
        projectCode: p.code,
        projectName: p.name,
        subjectId: m.id,
        subjectCode: m.code,
        subjectName: m.name,
        isLeaf: m.isLeaf,
        totalBudget: totalBudget.toFixed(2),
        paid: paid.toFixed(2),
        payable: payable.toFixed(2),
        totalOccupied: totalOccupied.toFixed(2),
        balance: balance.toFixed(2),
        executionRate: executionRate(totalOccupied, totalBudget),
        yearBudget: yearBudget === null ? null : yearBudget.toFixed(2),
        yearOccupied: filters.year === undefined ? null : yearOccupied.toFixed(2),
        yearBalance:
          filters.year === undefined ? null : (yearBudget ?? ZERO).minus(yearOccupied).toFixed(2),
      });
    }
  }

  // 4) 合计:基于去重叶集合(父子行同时命中不重复计数)。
  let tTotal = ZERO;
  let tPaid = ZERO;
  let tPayable = ZERO;
  let tYearBudget: D | null = null;
  let tYearPaid = ZERO;
  let tYearPayable = ZERO;
  for (const key of dedupLeafKeys) {
    const stb = stbByProjectSubject.get(key);
    if (stb) tTotal = tTotal.plus(fromStored(stb.currentAmount));
    const occ = occByProjectSubject.get(key);
    if (occ) {
      tPaid = tPaid.plus(occ.paid);
      tPayable = tPayable.plus(occ.payable);
      tYearPaid = tYearPaid.plus(occ.yearPaid);
      tYearPayable = tYearPayable.plus(occ.yearPayable);
    }
    if (filters.year !== undefined) {
      tYearBudget = (tYearBudget ?? ZERO).plus(
        fromStored(sbByProjectSubject.get(key)?.currentAmount ?? '0'),
      );
    }
  }
  const tOccupied = tPaid.plus(tPayable);
  const tYearOccupied = tYearPaid.plus(tYearPayable);

  return {
    hitProjects: new Set(rows.map((r) => r.projectId)).size,
    hitSubjects: rows.length,
    rows,
    total: {
      totalBudget: tTotal.toFixed(2),
      paid: tPaid.toFixed(2),
      payable: tPayable.toFixed(2),
      totalOccupied: tOccupied.toFixed(2),
      balance: tTotal.minus(tOccupied).toFixed(2),
      executionRate: executionRate(tOccupied, tTotal),
      yearBudget: tYearBudget === null ? null : tYearBudget.toFixed(2),
      yearOccupied: filters.year === undefined ? null : tYearOccupied.toFixed(2),
      yearBalance:
        filters.year === undefined ? null : (tYearBudget ?? ZERO).minus(tYearOccupied).toFixed(2),
    },
  };
}

// ---------------- 工具 ----------------

/** 校验 ISO yyyy-mm-dd 日期字符串,返回 UTC 0 点 Date(避免时区漂移)。 */
function parseDate(s: string, label: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    throw new HTTPError(422, `${label} 日期格式无效(应为 yyyy-mm-dd):${s}`);
  }
  const dt = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) {
    throw new HTTPError(422, `${label} 日期无效:${s}`);
  }
  return dt;
}
