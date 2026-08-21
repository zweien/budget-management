'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { CalendarDays } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface DatePickerProps {
  value?: Date;
  onChange?: (date: Date | undefined) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/** 解析 yyyy-M-d / yyyy/M/d / yyyy.M.d 为本地 Date;不合法返回 undefined。 */
function parseDate(text: string): Date | undefined {
  const m = text.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return undefined;
  return dt;
}

/**
 * Popover + 单日历的日期选择器(替代 antd DatePicker)。
 * 触发器是可键入的 Input:手输 yyyy-MM-dd(也认 / 或 . 分隔),解析合法即提交;
 * 中间态/非法文本只留在草稿里不打扰,失焦回显最后有效值(外部受控值)。
 * 显示值为 `draft ?? 受控值格式化` 派生:未编辑时外部变化即时反映。
 */
export function DatePicker({
  value,
  onChange,
  placeholder = '选择或输入日期',
  className,
  disabled,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<string | null>(null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className={cn('relative w-full', className)}>
          <CalendarDays className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-mute" />
          <Input
            disabled={disabled}
            value={draft ?? (value ? format(value, 'yyyy-MM-dd') : '')}
            placeholder={placeholder}
            className={cn('h-9 pl-8 tabular-nums', !value && 'text-mute')}
            onChange={(e) => {
              const text = e.target.value;
              setDraft(text);
              if (text.trim() === '') {
                onChange?.(undefined);
                return;
              }
              const parsed = parseDate(text);
              if (parsed) onChange?.(parsed);
            }}
            onBlur={() => setDraft(null)}
          />
        </div>
      </PopoverTrigger>
      {/* 阻止 Radix 打开时的自动聚焦日历:否则点击 Input 打开弹层后焦点被抢,
          Input 立即失焦清空草稿,"点击后直接键入"的流程无法成立。 */}
      <PopoverContent
        className="w-auto p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Calendar
          mode="single"
          selected={value}
          onSelect={(date) => {
            onChange?.(date);
            setDraft(null);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
