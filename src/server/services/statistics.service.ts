import { BusinessStatus, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission, denyApiKeyCrossProject } from '@/lib/auth/permissions';
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

  // ---- v0.15 扩展:全局录入页服务端筛选/分页(量级语义在实现内,页面只渲染) ----
  /** 项目集合(in;与 projectId 叠加取并集语义)。 */
  projectIds?: string[];
  /** 年度集合(in)。 */
  budgetYears?: number[];
  /** 状态集合(in;与 status 叠加)。 */
  statuses?: BusinessStatus[];
  /** 经办人集合(in;与 handler 模糊叠加)。 */
  handlers?: string[];
  /** 科目名集合(in,精确)。 */
  subjectNames?: string[];
  /** 录入人姓名集合(in)。 */
  creatorNames?: string[];
  /** 备注(contains,忽略大小写)。 */
  remark?: string;
  /** 摘要(contains,忽略大小写)。 */
  summary?: string;
  /** 单据编号(contains)。 */
  docNo?: string;
  /** 仅看无完成日期。 */
  completedDateEmpty?: boolean;
  /** 完成日期范围起(ISO yyyy-mm-dd,含)。 */
  completedDateFrom?: string;
  /** 完成日期范围止(ISO yyyy-mm-dd,含)。 */
  completedDateTo?: string;
  /** 金额下限(字符串十进制)。 */
  amountFrom?: string;
  /** 金额上限。 */
  amountTo?: string;
  /** 排序字段(白名单;缺省 businessDate desc, createdAt desc)。 */
  sort?: { field: CustomSortField; dir: 'asc' | 'desc' };
  /** 页码(1 起;缺省不分页,全量返回——保持既有调用兼容)。 */
  page?: number;
  /** 页大小(≤500;与 page 同时给出才生效)。 */
  pageSize?: number;
}

/** 服务端排序白名单(列 id → 排序目标;subject/creatorName 走关系字段)。 */
export const CUSTOM_SORT_FIELDS = {
  budgetYear: 'budgetYear',
  subject: 'subject',
  amount: 'amount',
  businessDate: 'businessDate',
  status: 'status',
  handler: 'handler',
  summary: 'summary',
  remark: 'remark',
  completedDate: 'completedDate',
  creatorName: 'creatorName',
} as const;
export type CustomSortField = (typeof CUSTOM_SORT_FIELDS)[keyof typeof CUSTOM_SORT_FIELDS];

/** 筛选集合计数(总计行/分页器)。 */
export interface CustomStatisticsStats {
  /** 筛选结果总行数(含作废)。 */
  totalCount: number;
  /** 有效(非作废)行数。 */
  validCount: number;
  /** 有效行金额合计。 */
  amountSum: string;
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

/** §11.3 业务明细行(join 科目,便于前端展示科目编码/名称;creatorName=录入人姓名)。 */
export type CustomStatisticsRecord = Omit<
  Prisma.BusinessRecordGetPayload<{
    include: {
      subject: { select: { id: true; code: true; name: true } };
      createdBy: { select: { name: true } };
    };
  }>,
  'createdBy'
> & { creatorName: string | null };

export interface CustomStatisticsResult {
  summary: CustomStatisticsSummary;
  records: CustomStatisticsRecord[];
  /** 筛选结果总行数(分页用;无分页时 = records.length)。 */
  total: number;
  /** 合计行/分页器数据(筛选全集聚合,SQL 下推)。 */
  stats: CustomStatisticsStats;
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
  // 1) 权限:v0.3.0 起普通用户全局只读,跨项目查询对所有登录用户开放;
  //    指定项目范围的凭证无 projectId 时拒绝(codex P1)。
  if (filters.projectId) {
    await requirePermission(user, 'project:view', filters.projectId);
  } else {
    await denyApiKeyCrossProject(user, 'project:view');
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
        total: 0,
        stats: { totalCount: 0, validCount: 0, amountSum: '0.00' },
      };
    }
  }

  // 3) 构建 business_records 查询条件(筛选全部在 SQL 侧,页面只渲染)。
  const where: Prisma.BusinessRecordWhereInput = {};
  const projectIdIn = [
    ...(filters.projectIds ?? []),
    ...(filters.projectId ? [filters.projectId] : []),
  ];
  if (projectIdIn.length > 0) where.projectId = { in: projectIdIn };
  const yearsIn = [
    ...(filters.budgetYears ?? []),
    ...(filters.budgetYear !== undefined ? [filters.budgetYear] : []),
  ];
  if (yearsIn.length > 0) where.budgetYear = { in: yearsIn };
  if (subjectLeafIds) where.subjectId = { in: [...subjectLeafIds] };
  const statusesIn = [...(filters.statuses ?? []), ...(filters.status ? [filters.status] : [])];
  if (statusesIn.length > 0) where.status = { in: statusesIn };
  if (filters.handlers?.length) {
    where.handler = { in: filters.handlers };
  } else if (filters.handler) {
    where.handler = { contains: filters.handler, mode: 'insensitive' };
  }
  if (filters.subjectNames?.length) {
    // subjectNames 精确 in 与科目模糊检索叠加(and)。
    where.AND = [{ subject: { name: { in: filters.subjectNames } } }];
  }
  if (filters.creatorNames?.length) {
    where.createdBy = { name: { in: filters.creatorNames } };
  }
  if (filters.remark) where.remark = { contains: filters.remark, mode: 'insensitive' };
  if (filters.summary) where.summary = { contains: filters.summary, mode: 'insensitive' };
  if (filters.docNo) where.docNo = { contains: filters.docNo };
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
  if (filters.completedDateEmpty) {
    where.completedDate = {
      ...(where.completedDate as object),
      equals: null,
    } as Prisma.DateTimeNullableFilter;
  }
  if (filters.completedDateFrom || filters.completedDateTo) {
    where.completedDate = {
      ...(where.completedDate as object),
      gte: filters.completedDateFrom
        ? parseDate(filters.completedDateFrom, 'completedDateFrom')
        : undefined,
      lte: filters.completedDateTo
        ? parseDate(filters.completedDateTo, 'completedDateTo')
        : undefined,
    } as Prisma.DateTimeNullableFilter;
  }
  if (filters.amountFrom || filters.amountTo) {
    for (const v of [filters.amountFrom, filters.amountTo]) {
      if (v !== undefined && !Number.isFinite(Number(v))) {
        throw new HTTPError(400, `金额筛选无效:${v}`);
      }
    }
    where.amount = {
      gte: filters.amountFrom,
      lte: filters.amountTo,
    };
  }

  // 排序(白名单;稳定尾排序 createdAt)。
  const sort = filters.sort;
  let orderBy: Prisma.BusinessRecordOrderByWithRelationInput[];
  if (sort && sort.field in CUSTOM_SORT_FIELDS) {
    const base =
      sort.field === 'subject'
        ? { subject: { name: sort.dir } }
        : sort.field === 'creatorName'
          ? { createdBy: { name: sort.dir } }
          : { [sort.field]: sort.dir };
    orderBy = [
      ...(sort.field === 'remark'
        ? [
            {
              remark: { sort: sort.dir, nulls: 'last' },
            } as Prisma.BusinessRecordOrderByWithRelationInput,
          ]
        : [base as Prisma.BusinessRecordOrderByWithRelationInput]),
      { createdAt: 'desc' },
    ];
  } else {
    orderBy = [{ businessDate: 'desc' }, { createdAt: 'desc' }];
  }

  // 分页(缺省全量,保持既有调用兼容)。
  const paginate: { skip?: number; take?: number } =
    filters.page !== undefined && filters.pageSize !== undefined && filters.pageSize > 0
      ? { skip: (Math.max(1, filters.page) - 1) * filters.pageSize, take: filters.pageSize }
      : {};

  const rows = await prisma.businessRecord.findMany({
    where,
    orderBy,
    ...paginate,
    include: {
      subject: { select: { id: true, code: true, name: true } },
      createdBy: { select: { name: true } },
    },
  });
  const records = rows.map(({ createdBy, ...r }) => ({
    ...r,
    creatorName: createdBy?.name ?? null,
  }));

  // 4) 合计与占用:SQL 聚合下推(筛选全集,不再全量取回内存计算)。
  const occRows = await prisma.businessRecord.groupBy({
    by: ['status'],
    where: { ...where, isVoid: false },
    _sum: { amount: true },
  });
  const paidD = fromStored(
    occRows.find((r) => r.status === 'PAID')?._sum.amount?.toFixed(2) ?? '0',
  );
  const payableD = fromStored(
    occRows
      .filter((r) => r.status !== 'PAID')
      .reduce((acc, r) => acc.plus(fromStored(r._sum.amount?.toFixed(2) ?? '0')), ZERO)
      .toFixed(2),
  );
  const occ = { paid: paidD, payable: payableD, totalOccupied: paidD.plus(payableD) };

  const [totalCount, validAgg] = await Promise.all([
    prisma.businessRecord.count({ where }),
    prisma.businessRecord.aggregate({
      where: { ...where, isVoid: false },
      _count: { id: true },
      _sum: { amount: true },
    }),
  ]);
  const stats: CustomStatisticsStats = {
    totalCount,
    validCount: validAgg._count.id,
    amountSum: fromStored(validAgg._sum.amount?.toFixed(2) ?? '0').toFixed(2),
  };

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
    total: totalCount,
    stats,
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

  // 单条 SQL 按月×状态聚合(business_date 存 UTC 0 点,EXTRACT(MONTH) 即业务月份)。
  const rows = await prisma.$queryRaw<
    Array<{ month: number; status: string; total: Prisma.Decimal }>
  >`
    SELECT EXTRACT(MONTH FROM business_date)::int AS month,
           status::text AS status,
           SUM(amount) AS total
    FROM business_records
    WHERE project_id = ${projectId}::uuid AND budget_year = ${year} AND is_void = false
    GROUP BY 1, 2
  `;

  const months: MonthlyHistoryBucket[] = [];
  for (let m = 1; m <= 12; m++) {
    const bucket = rows.filter((r) => r.month === m);
    const paid = bucket
      .filter((r) => r.status === 'PAID')
      .reduce((a, r) => a.plus(fromStored(r.total.toFixed(2))), ZERO);
    const payable = bucket
      .filter((r) => r.status !== 'PAID')
      .reduce((a, r) => a.plus(fromStored(r.total.toFixed(2))), ZERO);
    months.push({
      month: m,
      paid: paid.toFixed(2),
      payable: payable.toFixed(2),
      totalOccupied: paid.plus(payable).toFixed(2),
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
  // v0.3.0 起普通用户全局只读 → 跨项目统计对所有登录用户开放(只读聚合);
  // 指定项目范围的凭证拒绝(天然跨项目,codex P1)。
  await denyApiKeyCrossProject(user, 'project:view');

  // 1) 全部项目(非归档)逐项汇总。
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const projectIds = projects.map((p) => p.id);

  // 2) 一次性查预算 + 记录,再按项目分组,避免 N+1。
  // 指定年度时同时取年度预算:年度视图的预算口径 = Σ 年度预算(§codex 修复)——
  // 只编项目总预算、未编年度预算的项目在该年贡献 0 预算,与年度口径的占用一致。
  const [projectBudgets, annualBudgets, records] = await Promise.all([
    prisma.projectBudget.findMany({ where: { projectId: { in: projectIds } } }),
    filters.year !== undefined
      ? prisma.annualBudget.findMany({
          where: { projectId: { in: projectIds }, year: filters.year },
        })
      : Promise.resolve([]),
    prisma.businessRecord.findMany({
      where: {
        projectId: { in: projectIds },
        isVoid: false,
        ...(filters.year !== undefined ? { budgetYear: filters.year } : {}),
      },
    }),
  ]);

  const budgetByProject = new Map(projectBudgets.map((pb) => [pb.projectId, pb]));
  const annualByProject = new Map(annualBudgets.map((ab) => [ab.projectId, ab]));
  const recordsByProject = new Map<string, typeof records>();
  for (const r of records) {
    const list = recordsByProject.get(r.projectId) ?? [];
    list.push(r);
    recordsByProject.set(r.projectId, list);
  }

  // 3) 逐项目计算。预算口径:指定年度 → 该年度预算(未编年度的项目为 0);
  //    未指定年度 → 项目层当前总预算(§11.5)。
  const rows: CrossProjectStatisticsRow[] = projects.map((p) => {
    const pb = budgetByProject.get(p.id);
    const ab = annualByProject.get(p.id);
    const currentBudget: D =
      filters.year !== undefined
        ? ab
          ? fromStored(ab.currentAmount)
          : ZERO
        : pb
          ? fromStored(pb.currentAmount)
          : ZERO;
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
    // 无 projectId 的余额统计跨全部项目:指定项目范围的凭证拒绝(codex P1)。
    await denyApiKeyCrossProject(user, 'project:view');
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

  // 2) 预算 + 占用聚合一次取齐:记录按 项目×科目×状态 groupBy(SQL 下推),
  //    不再把全库记录拉进内存(跨项目余额视图的量级悬崖在此)。
  //    科目预算取全年度:§包干制的科目总口径 = Σ 各年度 SubjectBudget(回退),年份筛选在内存做。
  const [totalBudgets, occGrouped, yearOccGrouped, subjectBudgets] = await Promise.all([
    prisma.subjectTotalBudget.findMany({ where: { projectId: { in: projectIds } } }),
    prisma.businessRecord.groupBy({
      by: ['projectId', 'subjectId', 'status'],
      where: { projectId: { in: projectIds }, isVoid: false },
      _sum: { amount: true },
    }),
    filters.year === undefined
      ? Promise.resolve(
          [] as Array<{
            projectId: string;
            subjectId: string;
            status: string;
            _sum: { amount: Prisma.Decimal | null };
          }>,
        )
      : prisma.businessRecord.groupBy({
          by: ['projectId', 'subjectId', 'status'],
          where: { projectId: { in: projectIds }, budgetYear: filters.year, isVoid: false },
          _sum: { amount: true },
        }),
    prisma.subjectBudget.findMany({ where: { projectId: { in: projectIds } } }),
  ]);

  // §包干制(LUMP_SUM)项目集合:科目总预算口径回退为 Σ 各年度 SubjectBudget(Q6a)。
  const lumpSumProjects = new Set(
    projects.filter((p) => p.budgetMode === 'LUMP_SUM').map((p) => p.id),
  );
  const stbByProjectSubject = new Map(
    totalBudgets.map((t) => [`${t.projectId}|${t.subjectId}`, t]),
  );
  const sbByProjectSubject = new Map(
    subjectBudgets
      .filter((t) => filters.year === undefined || t.year === filters.year)
      .map((t) => [`${t.projectId}|${t.subjectId}`, t]),
  );
  const annualSumByProjectSubject = new Map<string, D>();
  for (const sb of subjectBudgets) {
    const key = `${sb.projectId}|${sb.subjectId}`;
    annualSumByProjectSubject.set(
      key,
      (annualSumByProjectSubject.get(key) ?? ZERO).plus(fromStored(sb.currentAmount)),
    );
  }
  /** 科目总预算口径:一般项目取 SubjectTotalBudget.currentAmount;包干项目 = Σ 各年度科目预算。 */
  const totalBudgetOf = (projectId: string, subjectId: string): D => {
    if (lumpSumProjects.has(projectId)) {
      return annualSumByProjectSubject.get(`${projectId}|${subjectId}`) ?? ZERO;
    }
    const stb = stbByProjectSubject.get(`${projectId}|${subjectId}`);
    return stb ? fromStored(stb.currentAmount) : ZERO;
  };

  interface OccAgg {
    paid: D;
    payable: D;
    yearPaid: D;
    yearPayable: D;
  }
  const occByProjectSubject = new Map<string, OccAgg>();
  const zeroAgg = (): OccAgg => ({ paid: ZERO, payable: ZERO, yearPaid: ZERO, yearPayable: ZERO });
  const addTo = (
    rows: Array<{
      projectId: string;
      subjectId: string;
      status: string;
      _sum: { amount: Prisma.Decimal | null };
    }>,
    pick: 'full' | 'year',
  ) => {
    for (const r of rows) {
      const key = `${r.projectId}|${r.subjectId}`;
      const agg = occByProjectSubject.get(key) ?? zeroAgg();
      const amount = fromStored(r._sum.amount?.toFixed(2) ?? '0');
      if (pick === 'full') {
        if (r.status === 'PAID') agg.paid = agg.paid.plus(amount);
        else agg.payable = agg.payable.plus(amount);
      } else {
        if (r.status === 'PAID') agg.yearPaid = agg.yearPaid.plus(amount);
        else agg.yearPayable = agg.yearPayable.plus(amount);
      }
      occByProjectSubject.set(key, agg);
    }
  };
  addTo(
    occGrouped as Array<{
      projectId: string;
      subjectId: string;
      status: string;
      _sum: { amount: Prisma.Decimal | null };
    }>,
    'full',
  );
  addTo(
    yearOccGrouped as Array<{
      projectId: string;
      subjectId: string;
      status: string;
      _sum: { amount: Prisma.Decimal | null };
    }>,
    'year',
  );

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
        totalBudget = totalBudget.plus(totalBudgetOf(p.id, leafId));
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
    const [pid, sid] = key.split('|');
    tTotal = tTotal.plus(totalBudgetOf(pid, sid));
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

// ============================================================
// §12.1 首页风险预警:跨项目负结余科目(单条 SQL 聚合)
// ============================================================

/** 风险预警行(负结余科目)。 */
export interface RiskSummaryRow {
  projectId: string;
  projectName: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  /** 该科目该年度预算(未编制视为 0)。 */
  budget: string;
  occupied: string;
  /** balance = budget − occupied(恒 < 0)。 */
  balance: string;
  executionRate: number | null;
}

/**
 * 跨项目风险摘要:一条 SQL 聚合全部项目的负结余科目,供首页「风险预警」一次取回,
 * 替代按项目逐个拉执行台账的 N×5 查询扇出。
 * 口径:指定年度、科目年度预算(SubjectBudget.currentAmount)vs 年度占用(有效记录),
 * 只报 balance < 0 的科目(父节点汇总负值由叶节点推导,不重复列出;已归档项目排除),
 * 按结余升序(最负/最严重在前)。全局只读;selected-scope 凭证拒绝(跨项目接口)。
 */
export async function riskSummary(
  filters: { year: number },
  user: Pick<User, 'id' | 'role'>,
): Promise<{ rows: RiskSummaryRow[] }> {
  await denyApiKeyCrossProject(user, 'project:view');
  const raw = await prisma.$queryRaw<
    Array<{
      projectId: string;
      projectName: string;
      subjectId: string;
      subjectCode: string;
      subjectName: string;
      budget: Prisma.Decimal;
      occupied: Prisma.Decimal;
    }>
  >`
    SELECT b.project_id AS "projectId",
           p.name AS "projectName",
           b.subject_id AS "subjectId",
           bs.code AS "subjectCode",
           bs.name AS "subjectName",
           COALESCE(sb.current_amount, 0) AS "budget",
           SUM(b.amount) AS "occupied"
    FROM business_records b
    JOIN projects p ON p.id = b.project_id
    JOIN budget_subjects bs ON bs.id = b.subject_id
    LEFT JOIN subject_budgets sb
      ON sb.project_id = b.project_id AND sb.year = b.budget_year AND sb.subject_id = b.subject_id
    WHERE b.is_void = false AND b.budget_year = ${filters.year} AND p.archived_at IS NULL
    GROUP BY b.project_id, p.name, b.subject_id, bs.code, bs.name, sb.current_amount
    HAVING SUM(b.amount) > COALESCE(sb.current_amount, 0)
    ORDER BY COALESCE(sb.current_amount, 0) - SUM(b.amount) ASC
  `;
  const rows = raw.map((r) => {
    const budget = r.budget.toFixed(2);
    const occupied = r.occupied.toFixed(2);
    const b = Number.parseFloat(budget);
    const o = Number.parseFloat(occupied);
    return {
      projectId: r.projectId,
      projectName: r.projectName,
      subjectId: r.subjectId,
      subjectCode: r.subjectCode,
      subjectName: r.subjectName,
      budget,
      occupied,
      balance: (b - o).toFixed(2),
      executionRate: b > 0 ? o / b : null,
    };
  });
  return { rows };
}

// ---------------- 全局录入页筛选候选(§11.3 配套) ----------------

/** 筛选候选清单(值列漏斗的稳定选项,不随分页页内数据漂移)。 */
export interface CustomStatisticsFacets {
  years: number[];
  handlerNames: string[];
  creatorNames: string[];
  subjectNames: string[];
}

/**
 * 筛选候选:年度/经办人/录入人/科目名(仅叶科目,项目范围内)。
 * 全局只读;selected-scope 凭证拒绝(跨项目接口)。projectIds 为空 = 全部项目。
 */
export async function customStatisticsFacets(
  projectIds: string[] | null,
  user: Pick<User, 'id' | 'role'>,
): Promise<CustomStatisticsFacets> {
  await denyApiKeyCrossProject(user, 'project:view');
  const scopeWhere = projectIds?.length ? { projectId: { in: projectIds } } : {};

  const [yearRows, handlerRows, creatorRows, subjects] = await Promise.all([
    prisma.businessRecord.groupBy({ by: ['budgetYear'], where: scopeWhere }),
    prisma.businessRecord.findMany({
      where: scopeWhere,
      select: { handler: true },
      distinct: ['handler'],
    }),
    prisma.businessRecord.groupBy({ by: ['createdById'], where: scopeWhere }),
    prisma.budgetSubject.findMany({
      where: { ...scopeWhere, isLeaf: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const creatorUserIds = creatorRows.map((r) => r.createdById);
  const creators = creatorUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: creatorUserIds } },
        select: { name: true },
      })
    : [];

  return {
    years: yearRows.map((r) => r.budgetYear).sort((a, b) => b - a),
    handlerNames: handlerRows
      .map((r) => r.handler)
      .filter((h): h is string => !!h)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    creatorNames: creators
      .map((c) => c.name)
      .filter((n): n is string => !!n)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    subjectNames: subjects.map((s) => s.name),
  };
}
