import { describe, it, expect } from 'vitest';
import { executionRate } from '@/lib/budget/rate';
import { fromStored } from '@/lib/decimal';

describe('executionRate', () => {
  it('正常计算执行率(占用/当前预算)', () => {
    expect(executionRate(fromStored('80'), fromStored('100'))).toBeCloseTo(0.8, 10);
  });

  it('当前预算为 0 时返回 null(§4.5 不得除零)', () => {
    expect(executionRate(fromStored('50'), fromStored('0'))).toBeNull();
  });

  it('超预算时执行率 > 1', () => {
    expect(executionRate(fromStored('120'), fromStored('100'))).toBeCloseTo(1.2, 10);
  });

  it('占用为 0 时执行率为 0', () => {
    expect(executionRate(fromStored('0'), fromStored('100'))).toBeCloseTo(0, 10);
  });
});
