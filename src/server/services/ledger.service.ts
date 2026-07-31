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
  initial: string;
  adjustment: string;
  current: string;
  /** 科目总预算当前值(SubjectTotalBudget.currentAmount,跨年度;父节点上卷)。 */
  totalCurrent: string;
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
  const [subjects, subjectBudgets, subjectTotalBudgets, records] = await Promise.all([
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
    initial: D;
    adjustment: D;
    current: D;
    totalCurrent: D;
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
      // 科目总预算(叶节点取自身 SubjectTotalBudget;未编制则为 0)。
      const stb = totalBudgetBySubject.get(s.id);
      const totalCurrent = stb ? fromStored(stb.currentAmount) : ZERO;
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
        initial,
        adjustment,
        current,
        totalCurrent,
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
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
        totalCurrent: ZERO,
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
    initial: D;
    adjustment: D;
    current: D;
    totalCurrent: D;
    paid: D;
    payable: D;
    totalOccupied: D;
  } => {
    const node = aggById.get(nodeId);
    if (!node) {
      return {
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
        totalCurrent: ZERO,
        paid: ZERO,
        payable: ZERO,
        totalOccupied: ZERO,
      };
    }
    if (node.isLeaf) {
      return {
        initial: node.initial,
        adjustment: node.adjustment,
        current: node.current,
        totalCurrent: node.totalCurrent,
        paid: node.paid,
        payable: node.payable,
        totalOccupied: node.totalOccupied,
      };
    }
    const children = subjects.filter((s) => s.parentId === nodeId);
    if (children.length === 0) {
      return {
        initial: ZERO,
        adjustment: ZERO,
        current: ZERO,
        totalCurrent: ZERO,
        paid: ZERO,
        payable: ZERO,
        totalOccupied: ZERO,
      };
    }
    const childResults = children.map((c) => rollup(c.id));
    node.initial = sumAmounts(childResults.map((c) => c.initial));
    node.adjustment = sumAmounts(childResults.map((c) => c.adjustment));
    node.current = sumAmounts(childResults.map((c) => c.current));
    node.totalCurrent = sumAmounts(childResults.map((c) => c.totalCurrent));
    node.paid = sumAmounts(childResults.map((c) => c.paid));
    node.payable = sumAmounts(childResults.map((c) => c.payable));
    node.totalOccupied = sumAmounts(childResults.map((c) => c.totalOccupied));
    return {
      initial: node.initial,
      adjustment: node.adjustment,
      current: node.current,
      totalCurrent: node.totalCurrent,
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
      initial: a.initial.toFixed(2),
      adjustment: a.adjustment.toFixed(2),
      current: a.current.toFixed(2),
      totalCurrent: a.totalCurrent.toFixed(2),
      paid: a.paid.toFixed(2),
      payable: a.payable.toFixed(2),
      totalOccupied: a.totalOccupied.toFixed(2),
      balance: balance.toFixed(2),
      executionRate: executionRate(a.totalOccupied, a.current),
    };
  });

  return { year, nodes };
}
