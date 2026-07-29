import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';

// 全系统金额:18 位精度,2 位小数,四舍五入
Decimal.set({ precision: 18, rounding: Decimal.ROUND_HALF_UP });

export const D = Decimal;
export type D = Decimal;

export const ZERO = new Decimal(0);

/** 领域 Decimal → 数据库存储(Prisma Decimal) */
export function toStored(d: D): Prisma.Decimal {
  return new Prisma.Decimal(d.toFixed(2));
}

/** Prisma Decimal / 字符串 / 数字 → 领域 Decimal */
export function fromStored(d: Prisma.Decimal | string | number): D {
  return new Decimal(typeof d === 'number' ? String(d) : d.toString());
}

/** 金额求和(空数组返回 ZERO) */
export function sumAmounts(amounts: D[]): D {
  return amounts.reduce((acc, a) => acc.plus(a), ZERO);
}

/** 金额比较是否 >= 0(用于校验非负) */
export function isNonNegative(d: D): boolean {
  return d.gte(ZERO);
}
