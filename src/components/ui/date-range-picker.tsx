'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { CalendarDays, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange | undefined) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/** Popover + range Calendar 的日期区间选择器(替代 antd RangePicker)。 */
export function DateRangePicker({
  value,
  onChange,
  placeholder = '选择日期区间',
  className,
  disabled,
}: DateRangePickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn('w-full justify-start font-normal', !value?.from && 'text-mute', className)}
        >
          <CalendarDays />
          {value?.from ? (
            value.to ? (
              <span className="tabular-nums">
                {format(value.from, 'yyyy-MM-dd')} — {format(value.to, 'yyyy-MM-dd')}
              </span>
            ) : (
              <span className="tabular-nums">{format(value.from, 'yyyy-MM-dd')}</span>
            )
          ) : (
            placeholder
          )}
          {value?.from ? (
            <span
              role="button"
              aria-label="清空日期"
              className="ml-auto rounded-sm text-mute transition-colors hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange?.(undefined);
              }}
            >
              <X className="size-3.5" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="range" selected={value} onSelect={onChange} numberOfMonths={1} />
      </PopoverContent>
    </Popover>
  );
}
