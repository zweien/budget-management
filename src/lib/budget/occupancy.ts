import { BusinessStatus } from '@prisma/client';
import { D, fromStored, sumAmounts } from '@/lib/decimal';

export interface OccupancyInput {
  records: { amount: D | { toString(): string }; status: BusinessStatus; isVoid: boolean }[];
}

export interface OccupancyResult {
  paid: D;
  payable: D;
  totalOccupied: D;
}

/**
 * §4.5 预算占用计算
 * 已支出金额 = 状态为 PAID 的有效记录金额合计
 * 应付未付 = 状态为 PLACEHOLDER/CONTRACT/FINANCE_APPROVAL 的有效记录金额合计
 * 总占用 = 已支出 + 应付未付
 * 作废记录不计入。
 *
 * 注:金额为 2 位小数货币,但 Decimal.toString() 会去除尾零(如 100 而非 100.00)。
 * 调用方需 2 位小数展示时请使用 formatMoney(result.paid) 等 money.ts 工具。
 */
export function computeOccupancy(input: OccupancyInput): OccupancyResult {
  const effective = input.records.filter((r) => !r.isVoid);
  const paid = sumAmounts(
    effective.filter((r) => r.status === 'PAID').map((r) => fromStored(r.amount.toString())),
  );
  const payable = sumAmounts(
    effective.filter((r) => r.status !== 'PAID').map((r) => fromStored(r.amount.toString())),
  );
  const totalOccupied = paid.plus(payable);
  return { paid, payable, totalOccupied };
}
