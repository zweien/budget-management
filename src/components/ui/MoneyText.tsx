'use client';

import { formatMoney, isNegative, parseMoney } from '@/lib/budget/money';
import { cn } from '@/lib/utils';

interface Props {
  /** 金额字符串(来自接口,§5 字符串传输) */
  value: string;
  /** 负数是否显示"超预算"风险色(§12.2) */
  riskOnNegative?: boolean;
  className?: string;
}

/** §12.2 金额统一右对齐、两位小数;负数用风险色(DESIGN.md error-deep) */
export function MoneyText({ value, riskOnNegative = true, className }: Props) {
  const d = parseMoney(value);
  const text = formatMoney(d);
  const isRisk = riskOnNegative && isNegative(d);
  return (
    <span className={cn('block text-right tabular-nums', isRisk && 'text-error-deep', className)}>
      {isRisk ? `${text} 超预算` : text}
    </span>
  );
}
