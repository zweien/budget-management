'use client';
import { Typography } from 'antd';
import { formatMoney, isNegative, parseMoney } from '@/lib/budget/money';

const { Text } = Typography;

interface Props {
  /** 金额字符串(来自接口,§5 字符串传输) */
  value: string;
  /** 负数是否显示"超预算"风险色(§12.2) */
  riskOnNegative?: boolean;
}

/** §12.2 金额统一右对齐、两位小数;负数用风险色 */
export function MoneyText({ value, riskOnNegative = true }: Props) {
  const d = parseMoney(value);
  const text = formatMoney(d);
  const isRisk = riskOnNegative && isNegative(d);
  return (
    <Text style={{ float: 'right', color: isRisk ? '#cf1322' : undefined }}>
      {isRisk ? `${text} 超预算` : text}
    </Text>
  );
}
