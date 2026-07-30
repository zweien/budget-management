import { D } from '@/lib/decimal';

/**
 * §4.5 执行率 = 总占用 ÷ 当前预算
 * 当前预算为 0 时返回 null(界面显示"—",不产生除零错误)
 * 返回值为 0-1 区间的 number(可能 > 1 表示超预算),用于百分比展示。
 */
export function executionRate(totalOccupied: D, currentBudget: D): number | null {
  if (currentBudget.isZero()) return null;
  return Number(totalOccupied.div(currentBudget));
}
