'use client';

import { InputNumber } from 'antd';
import type { InputNumberProps } from 'antd';
import { D, fromStored } from '@/lib/decimal';

interface AmountInputProps extends Omit<
  InputNumberProps<string>,
  'value' | 'onChange' | 'min' | 'parser' | 'formatter'
> {
  /** 金额字符串(§5 JSON 字符串传输),如 "1234.56"。允许 undefined/空串。 */
  value?: string;
  /**
   * 回调:输出仍是字符串(.toFixed(2)),保证表单状态与传输格式一致。
   * 输入被清空时回传 undefined(交由表单 required 处理)。
   */
  onChange?: (value: string | undefined) => void;
  /** 是否允许负数(默认 false;预算调整场景需置 true,§6.4)。 */
  allowNegative?: boolean;
}

/**
 * §12.2 金额输入:统一收/出字符串(两位小数),用于预算编制、调整等表单。
 * - parser:剥离非数字字符(负号视 allowNegative 决定是否保留),保留单个小数点。
 * - formatter:输入时即时展示两位小数千分位。
 * - min=0(allowNegative=false 时),禁止输入负数。
 * 受控值 value 为 decimal 字符串;onChange 透传 `.toFixed(2)` 字符串或 undefined。
 */
export function AmountInput({ value, onChange, allowNegative = false, ...rest }: AmountInputProps) {
  const handleParser: InputNumberProps<string>['parser'] = (displayValue) => {
    if (displayValue == null) return '';
    const raw = String(displayValue).trim();
    if (raw === '') return '';
    // 允许负号取决于 allowNegative;保留首个小数点。
    const stripped = raw.replace(allowNegative ? /[^0-9.\-]/g : /[^0-9.]/g, '');
    const firstDot = stripped.indexOf('.');
    let normalized: string;
    if (firstDot >= 0) {
      normalized =
        stripped.slice(0, firstDot + 1) + stripped.slice(firstDot + 1).replace(/\./g, '');
    } else {
      normalized = stripped;
    }
    if (allowNegative) {
      const minusIdx = normalized.indexOf('-');
      if (minusIdx > 0) {
        normalized = '-' + normalized.replace(/-/g, '');
      } else {
        normalized = normalized.replace(/-/g, minusIdx === 0 ? '-' : '');
      }
    }
    return normalized;
  };

  const handleFormatter: InputNumberProps<string>['formatter'] = (num) => {
    if (num == null || num === '') return '';
    try {
      const d = fromStored(String(num));
      if (!d.isFinite()) return '';
      return d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    } catch {
      return '';
    }
  };

  const handleChange = (next: string | null) => {
    if (next == null || next === '') {
      onChange?.(undefined);
      return;
    }
    try {
      const d: D = fromStored(next);
      onChange?.(d.isFinite() ? d.toFixed(2) : undefined);
    } catch {
      onChange?.(undefined);
    }
  };

  return (
    <InputNumber<string>
      style={{ width: '100%' }}
      stringMode
      value={value ?? ''}
      onChange={handleChange}
      parser={handleParser}
      formatter={handleFormatter}
      min={allowNegative ? undefined : '0'}
      step="0.01"
      precision={2}
      {...rest}
    />
  );
}
