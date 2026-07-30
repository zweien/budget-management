import { D } from '@/lib/decimal';

/**
 * §7.4 科目可调额度 = 科目当前预算 - 科目总占用
 */
export function adjustableAmount(currentBudget: D, totalOccupied: D): D {
  return currentBudget.minus(totalOccupied);
}

/**
 * §7.4 可操作额度 = 科目当前预算 - 科目总占用 - 待审批调整锁定金额
 * 返回负值表示锁定/占用已超出,用于预警(§13.2)。
 */
export function operableAmount(currentBudget: D, totalOccupied: D, pendingLock: D): D {
  return currentBudget.minus(totalOccupied).minus(pendingLock);
}
