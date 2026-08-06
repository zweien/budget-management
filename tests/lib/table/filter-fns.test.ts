import { describe, it, expect } from 'vitest';

import { multiSelect, textContains, numberRange, dateRange } from '@/lib/table/filter-fns';

// filterFn 签名为 (row, columnId, filterValue, addMeta);测试传 4 个参数,addMeta 为 noop。
const NOOP = () => {};
function makeRow<T>(value: T) {
  return { getValue: () => value } as never;
}

describe('multiSelect', () => {
  const fn = multiSelect();
  it('空数组/undefined 视为不过滤', () => {
    expect(fn(makeRow('A'), 'x', undefined, NOOP)).toBe(true);
    expect(fn(makeRow('A'), 'x', [], NOOP)).toBe(true);
  });
  it('行值 ∈ 选中集合放行', () => {
    expect(fn(makeRow('B'), 'x', ['A', 'B'], NOOP)).toBe(true);
  });
  it('行值 ∉ 选中集合拒绝', () => {
    expect(fn(makeRow('C'), 'x', ['A', 'B'], NOOP)).toBe(false);
  });
  it('数字与原生类型一致比较', () => {
    expect(fn(makeRow(2026), 'x', [2026, 2025], NOOP)).toBe(true);
    expect(fn(makeRow(2024), 'x', [2026, 2025], NOOP)).toBe(false);
  });
});

describe('textContains', () => {
  const fn = textContains();
  it('空串/空白视为不过滤', () => {
    expect(fn(makeRow('采购材料'), 'x', undefined, NOOP)).toBe(true);
    expect(fn(makeRow('采购材料'), 'x', '   ', NOOP)).toBe(true);
  });
  it('忽略大小写包含匹配', () => {
    expect(fn(makeRow('采购材料'), 'x', '材料', NOOP)).toBe(true);
    expect(fn(makeRow('采购材料'), 'x', '采', NOOP)).toBe(true);
    expect(fn(makeRow('采购材料'), 'x', '销售', NOOP)).toBe(false);
  });
  it('空值行不匹配任何关键词', () => {
    expect(fn(makeRow(null), 'x', 'x', NOOP)).toBe(false);
  });
});

describe('numberRange', () => {
  const fn = numberRange();
  it('无 min/max 视为不过滤', () => {
    expect(fn(makeRow('100'), 'x', undefined, NOOP)).toBe(true);
    expect(fn(makeRow('100'), 'x', {}, NOOP)).toBe(true);
  });
  it('闭区间:仅下界', () => {
    expect(fn(makeRow('150'), 'x', { min: '100' }, NOOP)).toBe(true);
    expect(fn(makeRow('50'), 'x', { min: '100' }, NOOP)).toBe(false);
  });
  it('闭区间:仅上界', () => {
    expect(fn(makeRow('50'), 'x', { max: '100' }, NOOP)).toBe(true);
    expect(fn(makeRow('150'), 'x', { max: '100' }, NOOP)).toBe(false);
  });
  it('闭区间:两端', () => {
    expect(fn(makeRow('100'), 'x', { min: '100', max: '200' }, NOOP)).toBe(true);
    expect(fn(makeRow('200'), 'x', { min: '100', max: '200' }, NOOP)).toBe(true);
    expect(fn(makeRow('99'), 'x', { min: '100', max: '200' }, NOOP)).toBe(false);
    expect(fn(makeRow('201'), 'x', { min: '100', max: '200' }, NOOP)).toBe(false);
  });
  it('非数值行被拒绝', () => {
    expect(fn(makeRow('abc'), 'x', { min: '10' }, NOOP)).toBe(false);
  });
});

describe('dateRange', () => {
  const fn = dateRange();
  it('无范围视为不过滤', () => {
    expect(fn(makeRow('2026-06-15T00:00:00Z'), 'x', undefined, NOOP)).toBe(true);
    expect(fn(makeRow('2026-06-15'), 'x', {}, NOOP)).toBe(true);
  });
  it('闭区间含边界日(from/to 当天均放行)', () => {
    expect(
      fn(
        makeRow('2026-06-15T12:00:00Z'),
        'x',
        { from: new Date('2026-06-15'), to: new Date('2026-06-15') },
        NOOP,
      ),
    ).toBe(true);
  });
  it('早于 from 拒绝;晚于 to 拒绝', () => {
    expect(fn(makeRow('2026-05-30'), 'x', { from: new Date('2026-06-01') }, NOOP)).toBe(false);
    expect(fn(makeRow('2026-07-10'), 'x', { to: new Date('2026-06-30') }, NOOP)).toBe(false);
  });
  it('to 当天(按本地日历)的记录仍在内', () => {
    // 存储格式为 UTC 午夜(见 parseBusinessDate);在 UTC+8 即当天 08:00 本地,
    // 应落在 to 当天的本地 23:59:59 之前。
    expect(fn(makeRow('2026-06-30T00:00:00Z'), 'x', { to: new Date('2026-06-30') }, NOOP)).toBe(
      true,
    );
  });
  it('非法日期行被拒绝', () => {
    expect(fn(makeRow('not-a-date'), 'x', { from: new Date('2026-01-01') }, NOOP)).toBe(false);
  });
});
