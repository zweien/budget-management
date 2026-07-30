import { describe, it, expect } from 'vitest';
import { computeOccupancy } from '@/lib/budget/occupancy';
import { fromStored } from '@/lib/decimal';

const amt = (n: string) => fromStored(n);

describe('computeOccupancy', () => {
  it('已支出计入 paid 与 totalOccupied,不计入 payable', () => {
    const r = computeOccupancy({
      records: [{ amount: amt('100'), status: 'PAID', isVoid: false }],
    });
    expect(r.paid.toFixed(2)).toBe('100.00');
    expect(r.payable.toFixed(2)).toBe('0.00');
    expect(r.totalOccupied.toFixed(2)).toBe('100.00');
  });

  it('非已支出三类计入 payable 与 totalOccupied,不计入 paid', () => {
    const r = computeOccupancy({
      records: [
        { amount: amt('50'), status: 'PLACEHOLDER', isVoid: false },
        { amount: amt('30'), status: 'CONTRACT', isVoid: false },
        { amount: amt('20'), status: 'FINANCE_APPROVAL', isVoid: false },
      ],
    });
    expect(r.paid.toFixed(2)).toBe('0.00');
    expect(r.payable.toFixed(2)).toBe('100.00');
    expect(r.totalOccupied.toFixed(2)).toBe('100.00');
  });

  it('作废记录不计入任何占用(§8.6)', () => {
    const r = computeOccupancy({
      records: [
        { amount: amt('100'), status: 'PAID', isVoid: false },
        { amount: amt('999'), status: 'PAID', isVoid: true },
      ],
    });
    expect(r.totalOccupied.toFixed(2)).toBe('100.00');
  });

  it('混合多种状态正确分类汇总', () => {
    const r = computeOccupancy({
      records: [
        { amount: amt('100'), status: 'PAID', isVoid: false },
        { amount: amt('50'), status: 'CONTRACT', isVoid: false },
        { amount: amt('25.5'), status: 'PLACEHOLDER', isVoid: false },
        { amount: amt('10'), status: 'PAID', isVoid: true },
      ],
    });
    expect(r.paid.toFixed(2)).toBe('100.00');
    expect(r.payable.toFixed(2)).toBe('75.50');
    expect(r.totalOccupied.toFixed(2)).toBe('175.50');
  });
});
