import { User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/auth/permissions';
import { D, ZERO, fromStored, sumAmounts } from '@/lib/decimal';
import { computeOccupancy, executionRate } from '@/lib/budget';

/**
 * 预算执行台账(§11.1/11.2):树形科目 + 每节点实时占用聚合。
 * 全部金额字段输出为 decimal 字符串(.toFixed(2),保留尾零)以适配 §5 JSON 传输;
 * executionRate 保持 number | null(便于前端直接渲染百分比)。
 */
export interface LedgerNode {
  subjectId: string;
  code: string;
  name: string;
  isLeaf: boolean;
  level: number;
  parentId: string | null;
  /** 总预算维度(SubjectTotalBudget,跨年度):原始/调整/当前。 */
  totalInitial: string;
  totalAdjustment: string;
  totalCurrent: string;
  /** 年度预算维度(SubjectBudget):原始/调整/当前。 */
  initial: string;
  adjustment: string;
  current: string;
  paid: string;
  payable: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
}

export interface ProjectLedger {
  year: number;
  nodes: LedgerNode[];
}

export interface ProjectTotalLedger {
  nodes: LedgerNode[];
}

/**
 * §总预算台账(跨年度口径):预算 = 科目总预算(SubjectTotalBudget;包干制回退为
 * 该科目各年度 SubjectBudget 之和),占用 = 全部年度非作废业务记录;
 * 结余 = 总预算·当前 − 总占用;执行率 = 总占用 ÷ 总预算·当前(0 → null)。
 * 年度维度列(initial/adjustment/current)恒 0——总口径下无年度维度,前端整组隐藏。
 */
export async function getProjectTotalLedger(
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<ProjectTotalLedger> {
  await requirePermission(user, 'project:view', projectId);

  const [project, subjects, subjectTotalBudgets, subjectBudgets, records] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { budgetMode: true } }),
    prisma.budgetSubject.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    }),
    prisma.subjectTotalBudget.findMany({ where: { projectId } }),
    // 全年度科目预算:包干制的科目总口径 = Σ 各年度(Q6a,与结余统计同口径)。
    prisma.subjectBudget.findMany({ where: { projectId } }),
    prisma.businessRecord.findMany({ where: { projectId, isVoid: false } }),
  ]);

  const lumpSum = project?.budgetMode === 'LUMP_SUM';
  const totalBudgetBySubject = new Map(subjectTotalBudgets.map((stb) => [stb.subjectId, stb]));
  const lumpSumSumsBySubject = new Map<string, { initial: D; adjustment: D; current: D }>();
  if (lumpSum) {
    for (const sb of subjectBudgets) {
      const acc = lumpSumSumsBySubject.get(sb.subjectId) ?? {
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
      };
      acc.initial = acc.initial.plus(fromStored(sb.initialAmount));
      acc.adjustment = acc.adjustment.plus(fromStored(sb.adjustmentAmount));
      acc.current = acc.current.plus(fromStored(sb.currentAmount));
      lumpSumSumsBySubject.set(sb.subjectId, acc);
    }
  }
  const recordsBySubject = new Map<string, typeof records>();
  for (const r of records) {
    const list = recordsBySubject.get(r.subjectId) ?? [];
    list.push(r);
    recordsBySubject.set(r.subjectId, list);
  }

  type TotalAgg = {
    subjectId: string;
    code: string;
    name: string;
    isLeaf: boolean;
    level: number;
    parentId: string | null;
    totalInitial: D;
    totalAdjustment: D;
    totalCurrent: D;
    paid: D;
    payable: D;
    totalOccupied: D;
  };

  const aggById = new Map<string, TotalAgg>();
  for (const s of subjects) {
    const base = {
      subjectId: s.id,
      code: s.code,
      name: s.name,
      isLeaf: s.isLeaf,
      level: s.level,
      parentId: s.parentId,
      totalInitial: ZERO,
      totalAdjustment: ZERO,
      totalCurrent: ZERO,
      paid: ZERO,
      payable: ZERO,
      totalOccupied: ZERO,
    };
    if (!s.isLeaf) {
      aggById.set(s.id, base);
      continue;
    }
    // 科目总预算三维度:一般项目取 SubjectTotalBudget;包干制回退 Σ 各年度。
    let totalInitial: D;
    let totalAdjustment: D;
    let totalCurrent: D;
    if (lumpSum) {
      const sums = lumpSumSumsBySubject.get(s.id);
      totalInitial = sums?.initial ?? ZERO;
      totalAdjustment = sums?.adjustment ?? ZERO;
      totalCurrent = sums?.current ?? ZERO;
    } else {
      const stb = totalBudgetBySubject.get(s.id);
      totalInitial = stb ? fromStored(stb.initialAmount) : ZERO;
      totalAdjustment = stb ? fromStored(stb.adjustmentAmount) : ZERO;
      totalCurrent = stb ? fromStored(stb.currentAmount) : ZERO;
    }
    const occ = computeOccupancy({
      records: (recordsBySubject.get(s.id) ?? []).map((r) => ({
        amount: r.amount,
        status: r.status,
        isVoid: r.isVoid,
      })),
    });
    aggById.set(s.id, {
      ...base,
      totalInitial,
      totalAdjustment,
      totalCurrent,
      paid: occ.paid,
      payable: occ.payable,
      totalOccupied: occ.totalOccupied,
    });
  }

  // 上卷:非叶节点 = 全部叶后代之和,自底向上递归。
  const rollup = (
    nodeId: string,
  ): Omit<TotalAgg, 'subjectId' | 'code' | 'name' | 'isLeaf' | 'level' | 'parentId'> => {
    const node = aggById.get(nodeId);
    if (!node) {
      return {
        totalInitial: ZERO,
        totalAdjustment: ZERO,
        totalCurrent: ZERO,
        paid: ZERO,
        payable: ZERO,
        totalOccupied: ZERO,
      };
    }
    if (node.isLeaf) {
      return node;
    }
    const children = subjects.filter((s) => s.parentId === nodeId);
    if (children.length === 0) {
      return node;
    }
    const childResults = children.map((c) => rollup(c.id));
    node.totalInitial = sumAmounts(childResults.map((c) => c.totalInitial));
    node.totalAdjustment = sumAmounts(childResults.map((c) => c.totalAdjustment));
    node.totalCurrent = sumAmounts(childResults.map((c) => c.totalCurrent));
    node.paid = sumAmounts(childResults.map((c) => c.paid));
    node.payable = sumAmounts(childResults.map((c) => c.payable));
    node.totalOccupied = sumAmounts(childResults.map((c) => c.totalOccupied));
    return node;
  };
  for (const s of subjects) {
    if (s.parentId === null) rollup(s.id);
  }

  const nodes: LedgerNode[] = subjects.map((s) => {
    const a = aggById.get(s.id)!;
    const balance = a.totalCurrent.minus(a.totalOccupied);
    return {
      subjectId: a.subjectId,
      code: a.code,
      name: a.name,
      isLeaf: a.isLeaf,
      level: a.level,
      parentId: a.parentId,
      totalInitial: a.totalInitial.toFixed(2),
      totalAdjustment: a.totalAdjustment.toFixed(2),
      totalCurrent: a.totalCurrent.toFixed(2),
      // 总口径下无年度维度,恒 0(前端整组隐藏)。
      initial: ZERO.toFixed(2),
      adjustment: ZERO.toFixed(2),
      current: ZERO.toFixed(2),
      paid: a.paid.toFixed(2),
      payable: a.payable.toFixed(2),
      totalOccupied: a.totalOccupied.toFixed(2),
      balance: balance.toFixed(2),
      executionRate: executionRate(a.totalOccupied, a.totalCurrent),
    };
  });

  return { nodes };
}

/**
 * §11.1 取项目某年度的预算执行台账。
 * - 权限:project:view + 项目范围。
 * - 查科目树 + 该年度 subject_budgets + 该年度非作废 business_records。
 * - 叶节点:current = subject_budget.currentAmount;占用走 computeOccupancy;父节点上卷。
 * - 金额输出为字符串(.toFixed(2));executionRate 为 number|null。
 *
 * 返回扁平数组(带 parentId),由前端按 parentId 组装 AntD Table tree-data。
 */
export async function getProjectLedger(
  projectId: string,
  year: number,
  user: Pick<User, 'id' | 'role'>,
): Promise<ProjectLedger> {
  await requirePermission(user, 'project:view', projectId);

  // 1) 科目树(全部,按编制顺序排序)+ 该年度 subject_budgets + 科目总预算(B模型) + 该年度非作废 business_records。
  const [project, subjects, subjectBudgets, subjectTotalBudgets, records] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { budgetMode: true } }),
    prisma.budgetSubject.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    }),
    prisma.subjectBudget.findMany({
      where: { projectId, year },
    }),
    prisma.subjectTotalBudget.findMany({
      where: { projectId },
    }),
    prisma.businessRecord.findMany({
      where: { projectId, budgetYear: year, isVoid: false },
    }),
  ]);

  // §包干制(LUMP_SUM):无科目总预算层,总口径回退为该科目各年度 SubjectBudget 之和
  // (Q6a,与结余统计同口径)——需全年度科目预算另行汇总。
  const lumpSum = project?.budgetMode === 'LUMP_SUM';
  const allYearSumsBySubject = new Map<string, { initial: D; adjustment: D; current: D }>();
  if (lumpSum) {
    const allYears = await prisma.subjectBudget.findMany({ where: { projectId } });
    for (const sb of allYears) {
      const acc = allYearSumsBySubject.get(sb.subjectId) ?? {
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
      };
      acc.initial = acc.initial.plus(fromStored(sb.initialAmount));
      acc.adjustment = acc.adjustment.plus(fromStored(sb.adjustmentAmount));
      acc.current = acc.current.plus(fromStored(sb.currentAmount));
      allYearSumsBySubject.set(sb.subjectId, acc);
    }
  }

  // 2) 索引:subjectId → 该年度预算(可能没有,如未编制或非叶节点)。
  const budgetBySubject = new Map(subjectBudgets.map((sb) => [sb.subjectId, sb]));
  // 索引:subjectId → 科目总预算(跨年度,叶节点有;非叶节点上卷)。
  const totalBudgetBySubject = new Map(subjectTotalBudgets.map((stb) => [stb.subjectId, stb]));
  // 索引:subjectId → 该科目下的非作废记录(computeOccupancy 已自检 isVoid,此处也只查了非作废)。
  const recordsBySubject = new Map<string, typeof records>();
  for (const r of records) {
    const list = recordsBySubject.get(r.subjectId) ?? [];
    list.push(r);
    recordsBySubject.set(r.subjectId, list);
  }

  // 3) 逐科目计算:叶节点用预算 + 占用;非叶节点稍后上卷。
  //    先按 subjectId 索引中间结果(Decimal),最后统一转字符串。
  type Agg = {
    subjectId: string;
    code: string;
    name: string;
    isLeaf: boolean;
    level: number;
    parentId: string | null;
    totalInitial: D;
    totalAdjustment: D;
    totalCurrent: D;
    initial: D;
    adjustment: D;
    current: D;
    paid: D;
    payable: D;
    totalOccupied: D;
  };

  const aggById = new Map<string, Agg>();
  for (const s of subjects) {
    const sb = budgetBySubject.get(s.id);
    if (s.isLeaf) {
      const initial = sb ? fromStored(sb.initialAmount) : ZERO;
      const current = sb ? fromStored(sb.currentAmount) : ZERO;
      const adjustment = current.minus(initial);
      // 科目总预算三维度(叶节点取自身 SubjectTotalBudget;未编制则为 0)。
      // §包干制:回退为各年度 SubjectBudget 三维度之和(总口径 = Σ年度)。
      let totalInitial: D;
      let totalAdjustment: D;
      let totalCurrent: D;
      if (lumpSum) {
        const sums = allYearSumsBySubject.get(s.id);
        totalInitial = sums?.initial ?? ZERO;
        totalAdjustment = sums?.adjustment ?? ZERO;
        totalCurrent = sums?.current ?? ZERO;
      } else {
        const stb = totalBudgetBySubject.get(s.id);
        totalInitial = stb ? fromStored(stb.initialAmount) : ZERO;
        totalAdjustment = stb ? fromStored(stb.adjustmentAmount) : ZERO;
        totalCurrent = stb ? fromStored(stb.currentAmount) : ZERO;
      }
      const occ = computeOccupancy({
        records: (recordsBySubject.get(s.id) ?? []).map((r) => ({
          amount: r.amount,
          status: r.status,
          isVoid: r.isVoid,
        })),
      });
      aggById.set(s.id, {
        subjectId: s.id,
        code: s.code,
        name: s.name,
        isLeaf: true,
        level: s.level,
        parentId: s.parentId,
        totalInitial,
        totalAdjustment,
        totalCurrent,
        initial,
        adjustment,
        current,
        paid: occ.paid,
        payable: occ.payable,
        totalOccupied: occ.totalOccupied,
      });
    } else {
      // 非叶节点金额只读,由叶节点上卷;占位 ZERO,后续 rollup 填入。
      aggById.set(s.id, {
        subjectId: s.id,
        code: s.code,
        name: s.name,
        isLeaf: false,
        level: s.level,
        parentId: s.parentId,
        totalInitial: ZERO,
        totalAdjustment: ZERO,
        totalCurrent: ZERO,
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
        paid: ZERO,
        payable: ZERO,
        totalOccupied: ZERO,
      });
    }
  }

  // 4) 上卷:非叶节点各字段 = 其全部叶后代对应字段之和。自底向上递归。
  //    children = 直接子节点(可能非叶或叶);叶节点直接返回自身值。
  const rollup = (
    nodeId: string,
  ): {
    totalInitial: D;
    totalAdjustment: D;
    totalCurrent: D;
    initial: D;
    adjustment: D;
    current: D;
    paid: D;
    payable: D;
    totalOccupied: D;
  } => {
    const node = aggById.get(nodeId);
    if (!node) {
      return {
        totalInitial: ZERO,
        totalAdjustment: ZERO,
        totalCurrent: ZERO,
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
        paid: ZERO,
        payable: ZERO,
        totalOccupied: ZERO,
      };
    }
    if (node.isLeaf) {
      return {
        totalInitial: node.totalInitial,
        totalAdjustment: node.totalAdjustment,
        totalCurrent: node.totalCurrent,
        initial: node.initial,
        adjustment: node.adjustment,
        current: node.current,
        paid: node.paid,
        payable: node.payable,
        totalOccupied: node.totalOccupied,
      };
    }
    const children = subjects.filter((s) => s.parentId === nodeId);
    if (children.length === 0) {
      return {
        totalInitial: ZERO,
        totalAdjustment: ZERO,
        totalCurrent: ZERO,
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
        paid: ZERO,
        payable: ZERO,
        totalOccupied: ZERO,
      };
    }
    const childResults = children.map((c) => rollup(c.id));
    node.totalInitial = sumAmounts(childResults.map((c) => c.totalInitial));
    node.totalAdjustment = sumAmounts(childResults.map((c) => c.totalAdjustment));
    node.totalCurrent = sumAmounts(childResults.map((c) => c.totalCurrent));
    node.initial = sumAmounts(childResults.map((c) => c.initial));
    node.adjustment = sumAmounts(childResults.map((c) => c.adjustment));
    node.current = sumAmounts(childResults.map((c) => c.current));
    node.paid = sumAmounts(childResults.map((c) => c.paid));
    node.payable = sumAmounts(childResults.map((c) => c.payable));
    node.totalOccupied = sumAmounts(childResults.map((c) => c.totalOccupied));
    return {
      totalInitial: node.totalInitial,
      totalAdjustment: node.totalAdjustment,
      totalCurrent: node.totalCurrent,
      initial: node.initial,
      adjustment: node.adjustment,
      current: node.current,
      paid: node.paid,
      payable: node.payable,
      totalOccupied: node.totalOccupied,
    };
  };

  // 对所有根节点(parentId == null)递归,会顺带填好所有非叶节点。
  for (const s of subjects) {
    if (s.parentId === null) rollup(s.id);
  }

  // 5) 转 LedgerNode:Decimal → .toFixed(2) 字符串;balance = current - totalOccupied;
  //    executionRate = totalOccupied / current(current=0 → null)。
  const nodes: LedgerNode[] = subjects.map((s) => {
    const a = aggById.get(s.id)!;
    const balance = a.current.minus(a.totalOccupied);
    return {
      subjectId: a.subjectId,
      code: a.code,
      name: a.name,
      isLeaf: a.isLeaf,
      level: a.level,
      parentId: a.parentId,
      totalInitial: a.totalInitial.toFixed(2),
      totalAdjustment: a.totalAdjustment.toFixed(2),
      totalCurrent: a.totalCurrent.toFixed(2),
      initial: a.initial.toFixed(2),
      adjustment: a.adjustment.toFixed(2),
      current: a.current.toFixed(2),
      paid: a.paid.toFixed(2),
      payable: a.payable.toFixed(2),
      totalOccupied: a.totalOccupied.toFixed(2),
      balance: balance.toFixed(2),
      executionRate: executionRate(a.totalOccupied, a.current),
    };
  });

  return { year, nodes };
}
