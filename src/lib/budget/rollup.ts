import { D, ZERO, sumAmounts } from '@/lib/decimal';

export interface SubjectNode {
  id: string;
  parentId: string | null;
  isLeaf: boolean;
  current: D;
}

/**
 * §4.4 非叶节点当前预算 = 其下全部叶节点当前预算之和
 */
export function rollupSubjectBudgets(leafCurrents: { subjectId: string; current: D }[]): D {
  return sumAmounts(leafCurrents.map((l) => l.current));
}

/**
 * 把扁平科目列表构建成树,并自底向上汇总每个非叶节点的 current。
 * 返回的数组每个节点 current 已被更新为(若是叶节点则原值;若是非叶节点则子树叶节点之和)。
 */
export function buildTreeRollup(nodes: SubjectNode[]): SubjectNode[] {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));

  // 递归计算某节点子树叶节点之和
  const compute = (nodeId: string): D => {
    const node = byId.get(nodeId)!;
    if (node.isLeaf) return node.current;
    const children = nodes.filter((n) => n.parentId === nodeId);
    if (children.length === 0) return ZERO;
    const childSum = sumAmounts(children.map((c) => compute(c.id)));
    node.current = childSum;
    return childSum;
  };

  // 对所有根节点(parentId == null)递归,会顺带填好所有非叶节点
  for (const n of byId.values()) {
    if (n.parentId === null) compute(n.id);
  }

  return Array.from(byId.values());
}
