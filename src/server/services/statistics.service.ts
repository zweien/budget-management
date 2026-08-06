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
  /** 预算科目 ID。 */
  subjectId?: string;
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

  // 2) 构建 business_records 查询条件。
  const where: Prisma.BusinessRecordWhereInput = {};
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.budgetYear !== undefined) where.budgetYear = filters.budgetYear;
  if (filters.subjectId) where.subjectId = filters.subjectId;
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

  // 3) 占用(computeOccupancy 对所查记录全集,内部已自检 isVoid)。
  const occ = computeOccupancy({
    records: records.map((r) => ({ amount: r.amount, status: r.status, isVoid: r.isVoid })),
  });

  // 4) 预算:筛选项目/年度对应的 subject_budgets.currentAmount 之和。
  //    跨项目(无 projectId)且未指定年度时,预算口径无意义,置 0。
  const sbWhere: Prisma.SubjectBudgetWhereInput = {};
  if (filters.projectId) sbWhere.projectId = filters.projectId;
  if (filters.budgetYear !== undefined) sbWhere.year = filters.budgetYear;
  const subjectBudgets = await prisma.subjectBudget.findMany({ where: sbWhere });
  const currentBudget = sumAmounts(subjectBudgets.map((sb) => fromStored(sb.currentAmount)));

  // 5) 结余 / 执行率。
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
