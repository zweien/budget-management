'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import { zhCN } from 'date-fns/locale';

import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * react-day-picker v9+ 风格日历;默认 zhCN locale(date-fns)。
 * 单元格 32px,选中态 primary(ink),range 中间态 accent 底。
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  locale = zhCN,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      locale={locale}
      className={cn('p-3', className)}
      classNames={{
        months: 'relative flex flex-col gap-4 sm:flex-row',
        month: 'flex w-full flex-col gap-4',
        month_caption: 'relative flex h-7 items-center justify-center',
        caption_label: 'text-sm font-medium',
        nav: 'absolute inset-x-0 top-0 flex h-7 items-center justify-between',
        button_previous: cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'size-7 bg-transparent p-0 opacity-60 hover:opacity-100',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'size-7 bg-transparent p-0 opacity-60 hover:opacity-100',
        ),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-8 rounded-md text-xs font-normal text-mute',
        weeks: 'flex flex-col gap-1',
        week: 'mt-1 flex',
        day: cn(
          'relative size-8 p-0 text-center text-sm focus-within:relative focus-within:z-20',
          '[&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md',
          '[&:has([aria-selected].day-outside)]:bg-accent/50',
          '[&:has([aria-selected].day-range-end)]:rounded-r-md',
        ),
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-8 p-0 font-normal aria-selected:opacity-100',
        ),
        range_start: 'day-range-start rounded-l-md',
        range_end: 'day-range-end rounded-r-md',
        selected:
          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground',
        today: 'bg-accent text-accent-foreground',
        outside:
          'day-outside text-mute opacity-50 aria-selected:bg-accent/50 aria-selected:text-mute aria-selected:opacity-40',
        disabled: 'text-mute opacity-50',
        range_middle: 'aria-selected:bg-accent aria-selected:text-accent-foreground',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...props }) =>
          orientation === 'left' ? (
            <ChevronLeft className="size-4" {...props} />
          ) : (
            <ChevronRight className="size-4" {...props} />
          ),
      }}
      {...props}
    />
  );
}

export { Calendar };
