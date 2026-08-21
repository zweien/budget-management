'use client';

import * as React from 'react';

import { D, fromStored } from '@/lib/decimal';
import { cn } from '@/lib/utils';

interface AmountInputProps extends Omit<
  React.ComponentProps<'input'>,
  'value' | 'onChange' | 'min' | 'type' | 'size'
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
  /** 密度:'sm' 用于表格内编辑。 */
  size?: 'sm' | 'default';
  /**
   * 输入开始(每次按键)即回调:草稿要等失焦才 emit,父级若需尽早标记表单脏
   * (装离开拦截防聚焦中刷新丢草稿),用此回调;须传稳定引用。
   */
  onEditStart?: () => void;
}

/** 剥离非数字字符(负号视 allowNegative 决定是否保留),保留单个小数点。 */
function parseRaw(raw: string, allowNegative: boolean): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const stripped = trimmed.replace(allowNegative ? /[^0-9.\-]/g : /[^0-9.]/g, '');
  const firstDot = stripped.indexOf('.');
  let normalized: string;
  if (firstDot >= 0) {
    normalized = stripped.slice(0, firstDot + 1) + stripped.slice(firstDot + 1).replace(/\./g, '');
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
}

/** 千分位 + 两位小数的展示格式(失焦时)。 */
function formatDisplay(stored: string | undefined): string {
  if (stored == null || stored === '') return '';
  try {
    const d = fromStored(stored);
    if (!d.isFinite()) return '';
    return d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } catch {
    return '';
  }
}

/** 编辑态展示:两位小数、无千分位(避免光标跳动)。 */
function plainDisplay(stored: string | undefined): string {
  if (stored == null || stored === '') return '';
  try {
    const d = fromStored(stored);
    return d.isFinite() ? d.toFixed(2) : '';
  } catch {
    return '';
  }
}

/**
 * §12.2 金额输入:统一收/出字符串(两位小数),用于预算编制、调整等表单。
 * antd InputNumber 的 shadcn 移植:输入时展示解析后的原始文本,失焦回显千分位格式;
 * allowNegative=false 时失焦钳制到 0(对齐原 min=0 行为)。
 */
export function AmountInput({
  value,
  onChange,
  onEditStart,
  allowNegative = false,
  size = 'default',
  className,
  ...rest
}: AmountInputProps) {
  // 非 null 表示编辑中(聚焦)的原始文本;失焦回落到 value 的格式化展示。
  const [raw, setRaw] = React.useState<string | null>(null);

  const emit = (next: string) => {
    if (next === '') {
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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onEditStart?.();
    // 只更新本地草稿,提交延到失焦:表格场景(如初始预算树表)每次按键 emit
    // 会触发父级 setState 重建整表,打断输入(焦点丢失/组词中断)。
    setRaw(parseRaw(e.target.value, allowNegative));
  };

  const handleFocus = () => {
    setRaw(plainDisplay(value));
  };

  /** 提交草稿(含负数钳制)并退出编辑态;blur 与 Enter 前置提交共用。 */
  const flush = () => {
    if (raw !== null) {
      let v = raw;
      if (!allowNegative && v !== '') {
        try {
          const d = fromStored(v);
          if (d.isFinite() && d.isNegative()) v = '0';
        } catch {
          // 非法文本由 emit 回传 undefined。
        }
      }
      emit(v);
    }
    setRaw(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 聚焦中按 Enter:浏览器直接提交表单且不触发 blur,须先把草稿 emit 给表单,
    // 否则提交的是旧值(编辑场景会静默提交旧金额)。
    if (e.key === 'Enter') flush();
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      data-slot="amount-input"
      className={cn(
        'flex w-full min-w-0 rounded-md border border-input bg-card px-2.5 py-1 text-right text-sm tabular-nums shadow-l1 transition-colors outline-none',
        size === 'default' ? 'h-8' : 'h-7 text-xs',
        'placeholder:text-left placeholder:font-normal placeholder:text-mute',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
        className,
      )}
      value={raw ?? formatDisplay(value)}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={flush}
      onKeyDown={handleKeyDown}
      {...rest}
    />
  );
}
