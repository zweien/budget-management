/**
 * 台账年度下拉的固定窗口(纯函数:服务端算候选、客户端回落候选共用)。
 */

/** 固定窗口年数:今年 + 前 4 年。 */
export const LEDGER_YEAR_WINDOW = 5;

/** 固定窗口:今年起往前 LEDGER_YEAR_WINDOW 年,降序。 */
export function ledgerYearWindow(currentYear: number): number[] {
  return Array.from({ length: LEDGER_YEAR_WINDOW }, (_, i) => currentYear - i);
}
