import { describe, it, expect } from 'vitest';
import { adjustableAmount, operableAmount } from '@/lib/budget/adjustable';
import { fromStored } from '@/lib/decimal';

describe('adjustableAmount (§7.4 可调额度)', () => {
  it('可调额度 = 当前预算 - 总占用', () => {
    expect(adjustableAmount(fromStored('100'), fromStored('30')).toFixed(2)).toBe('70.00');
  });

  it('占用等于预算时可调额度为 0', () => {
    expect(adjustableAmount(fromStored('100'), fromStored('100')).toFixed(2)).toBe('0.00');
  });

  it('超占用时可调额度为负(允许)', () => {
    expect(adjustableAmount(fromStored('100'), fromStored('130')).toFixed(2)).toBe('-30.00');
  });
});

describe('operableAmount (§7.4 可操作额度)', () => {
  it('可操作额度 = 当前预算 - 总占用 - 待审批锁定', () => {
    expect(operableAmount(fromStored('100'), fromStored('30'), fromStored('20')).toFixed(2)).toBe(
      '50.00',
    );
  });

  it('锁定使可操作额度为负时返回负值(预警用)', () => {
    expect(operableAmount(fromStored('100'), fromStored('80'), fromStored('40')).toFixed(2)).toBe(
      '-20.00',
    );
  });

  it('无锁定时等于可调额度', () => {
    expect(operableAmount(fromStored('100'), fromStored('30'), fromStored('0')).toFixed(2)).toBe(
      '70.00',
    );
  });
});
