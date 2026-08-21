'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { CalendarDays, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';

import { cn } from '@/lib/utils';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange | undefined) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/** 从文本中提取前两个合法日期(yyyy-M-d 形态,分隔符认 - / .),from > to 时自动交换。 */
function parseRangeTokens(text: string): DateRange | undefined {
  const matches = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g) ?? [];
  const dates: Date[] = [];
  for (const token of matches) {
    if (dates.length >= 2) break;
    const parts = token.split(/[-/.]/);
    const y = Number(parts[0]);
    const mo = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) dates.push(dt);
  }
  if (dates.length === 0) return undefined;
  let [from, to] = dates;
  if (from && to && to < from) [from, to] = [to, from];
  return { from, to: dates.length > 1 ? to : undefined };
}

/**
 * Popover + range Calendar 的日期区间选择器(替代 antd RangePicker)。
 * 触发器是可键入的 Input:手输两个日期(任意分隔,如 `2026-01-01 ~ 2026-12-31`),
 * 提取到合法日期即提交;中间态/非法文本留在草稿里不打扰,失焦回显最后有效值。
 * 保留日历点选与一键清空。显示值为 `draft ?? 受控值格式化` 派生。
 */
export function DateRangePicker({
  value,
  onChange,
  placeholder = '选择或输入日期区间',
  className,
  disabled,
}: DateRangePickerProps) {
  const display = value?.from
    ? value.to
      ? `${format(value.from, 'yyyy-MM-dd')} — ${format(value.to, 'yyyy-MM-dd')}`
      : format(value.from, 'yyyy-MM-dd')
    : '';
  const [draft, setDraft] = React.useState<string | null>(null);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <div className={cn('relative w-full', className)}>
          <CalendarDays className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-mute" />
          <Input
            disabled={disabled}
            value={draft ?? display}
            placeholder={placeholder}
            className={cn('h-9 pr-8 pl-8 tabular-nums', !value?.from && 'text-mute')}
            onChange={(e) => {
              const text = e.target.value;
              setDraft(text);
              if (text.trim() === '') {
                onChange?.(undefined);
                return;
              }
              const parsed = parseRangeTokens(text);
              if (parsed) onChange?.(parsed);
            }}
            onBlur={() => setDraft(null)}
          />
          {value?.from ? (
            <span
              role="button"
              aria-label="清空日期"
              className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm text-mute transition-colors hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange?.(undefined);
                setDraft(null);
              }}
            >
              <X className="size-3.5" />
            </span>
          ) : null}
        </div>
      </PopoverTrigger>
      {/* 同 date-picker:阻止打开时自动聚焦日历,保持 Input 焦点可继续键入。 */}
      <PopoverContent
        className="w-auto p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Calendar mode="range" selected={value} onSelect={onChange} numberOfMonths={1} />
      </PopoverContent>
    </Popover>
  );
}
