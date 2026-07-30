import Decimal from 'decimal.js';
import { D } from '@/lib/decimal';

const nf = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 金额 → 展示字符串(两位小数,千分位),用于前端展示 */
export function formatMoney(d: D): string {
  return nf.format(Number(d.toFixed(2)));
}

export function isNegative(d: D): boolean {
  return d.lt(0);
}

/** 字符串(来自接口)→ Decimal */
export function parseMoney(s: string): D {
  return new Decimal(s);
}
