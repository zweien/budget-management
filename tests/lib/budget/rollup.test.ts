import { describe, it, expect } from 'vitest';
import { rollupSubjectBudgets, buildTreeRollup } from '@/lib/budget/rollup';
import { fromStored } from '@/lib/decimal';

describe('rollupSubjectBudgets', () => {
  it('非叶节点当前预算 = 叶节点当前预算之和', () => {
    const r = rollupSubjectBudgets([
      { subjectId: 'leaf1', current: fromStored('100') },
      { subjectId: 'leaf2', current: fromStored('50.5') },
    ]);
    expect(r.toFixed(2)).toBe('150.50');
  });

  it('空列表返回 0', () => {
    expect(rollupSubjectBudgets([]).toFixed(2)).toBe('0.00');
  });
});

describe('buildTreeRollup', () => {
  it('按 parent 关系自底向上汇总父节点金额', () => {
    const nodes = [
      { id: 'A', parentId: null, isLeaf: false, current: fromStored('0') },
      { id: 'A1', parentId: 'A', isLeaf: false, current: fromStored('0') },
      { id: 'A1a', parentId: 'A1', isLeaf: true, current: fromStored('100') },
      { id: 'A1b', parentId: 'A1', isLeaf: true, current: fromStored('20') },
      { id: 'A2', parentId: 'A', isLeaf: true, current: fromStored('30') },
    ];
    const rolled = buildTreeRollup(nodes);
    const find = (id: string) => rolled.find((n) => n.id === id)!;
    expect(find('A1').current.toFixed(2)).toBe('120.00');
    expect(find('A').current.toFixed(2)).toBe('150.00');
  });
});
