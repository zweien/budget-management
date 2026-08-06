'use client';

import * as React from 'react';
import type { Column } from '@tanstack/react-table';
import type { DateRange } from 'react-day-picker';
import { Funnel } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import type { NumberRangeValue } from '@/lib/table/filter-fns';

export type ColumnFilterType = 'values' | 'text' | 'range' | 'dateRange';

interface HeaderFilterProps<TData> {
  column: Column<TData, unknown>;
  title: string;
  type: ColumnFilterType;
  /** values 类型:原始值 → 展示文本(如状态码 → 中文)。 */
  valueLabels?: Record<string, string>;
  /**
   * values 类型:稳定的全量候选值清单。
   * 默认取 faceted unique values——但当本列过滤会改变其 faceted 集合时
   * (如项目列被自身过滤),应显式传入,使清单不受当前筛选影响(Excel 行为)。
   */
  options?: unknown[];
  placeholder?: string;
}

function isFilterActive(type: ColumnFilterType, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (type === 'values') return Array.isArray(value) && value.length > 0;
  if (type === 'text') return String(value).trim() !== '';
  if (type === 'range') {
    const v = value as NumberRangeValue;
    return Boolean(v?.min || v?.max);
  }
  const v = value as DateRange | undefined;
  return Boolean(v?.from || v?.to);
}

/**
 * Excel 式表头筛选:列标题 + 漏斗按钮(激活态 link 蓝)+ Popover。
 * - values:faceted 值清单(搜索 + 勾选 + 全选/清空)
 * - text:包含匹配输入
 * - range:金额 min/max
 * - dateRange:日期范围
 */
export function HeaderFilter<TData>({
  column,
  title,
  type,
  valueLabels,
  options,
  placeholder,
}: HeaderFilterProps<TData>) {
  const active = isFilterActive(type, column.getFilterValue());
  return (
    <span className="inline-flex items-center gap-1">
      <span>{title}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`筛选${title}`}
            className={cn(
              'rounded-sm p-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
              active ? 'text-link' : 'text-mute',
            )}
          >
            <Funnel className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2">
          {type === 'values' ? (
            <ValuesFilter column={column} valueLabels={valueLabels} options={options} />
          ) : null}
          {type === 'text' ? <TextFilter column={column} placeholder={placeholder} /> : null}
          {type === 'range' ? <RangeFilter column={column} /> : null}
          {type === 'dateRange' ? <DateRangeFilter column={column} /> : null}
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** 值清单勾选(faceted unique values;undefined=不过滤=全部勾选)。
 *  选项值保持原生类型(年度为 number),与 filterFn 的 includes 比较一致。 */
function ValuesFilter<TData>({
  column,
  valueLabels,
  options,
}: {
  column: Column<TData, unknown>;
  valueLabels?: Record<string, string>;
  options?: unknown[];
}) {
  const faceted = column.getFacetedUniqueValues();
  // 候选清单:优先用外部传入的稳定 options;否则取 faceted unique values
  // (当本列过滤不影响自身 faceted 时可用,如经办人/状态;项目/年度这类
  //  过滤会改变自身 faceted 集合的列必须传 options,否则勾选后选项漂移)。
  const allValues = React.useMemo(
    () =>
      (options ?? Array.from(faceted.keys())).sort((a, b) =>
        String(a).localeCompare(String(b), 'zh-CN', { numeric: true }),
      ),
    [faceted, options],
  );
  const selected = column.getFilterValue() as unknown[] | undefined;
  // undefined 视为全选(不过滤)。
  const selectedSet = React.useMemo(() => new Set(selected ?? allValues), [selected, allValues]);
  const [search, setSearch] = React.useState('');

  const labelOf = (v: unknown) => valueLabels?.[String(v)] ?? String(v);

  const visible = React.useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return allValues;
    return allValues.filter((v) => labelOf(v).toLowerCase().includes(kw));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allValues, search, valueLabels]);

  const apply = (next: Set<unknown>) => {
    // 全量勾选等同于不过滤(undefined),避免"全选"也产生筛选语义。
    if (next.size === 0 || next.size === allValues.length) {
      column.setFilterValue(undefined);
    } else {
      column.setFilterValue(Array.from(next));
    }
  };

  const toggle = (v: unknown, checked: boolean) => {
    const next = new Set(selectedSet);
    if (checked) next.add(v);
    else next.delete(v);
    apply(next);
  };

  return (
    <div className="space-y-1.5">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="搜索选项…"
        className="h-7 text-xs"
      />
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">无匹配选项</p>
        ) : (
          visible.map((v) => (
            <label
              key={String(v)}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={selectedSet.has(v)}
                onCheckedChange={(c) => toggle(v, c === true)}
              />
              <span className="flex-1 truncate">{labelOf(v)}</span>
              <span className="caption-mono text-mute">{faceted.get(v) ?? ''}</span>
            </label>
          ))
        )}
      </div>
      <div className="flex justify-between border-t border-border pt-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={() => apply(new Set(allValues))}
        >
          全选
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={() => column.setFilterValue(undefined)}
        >
          清除筛选
        </Button>
      </div>
    </div>
  );
}

function TextFilter<TData>({
  column,
  placeholder,
}: {
  column: Column<TData, unknown>;
  placeholder?: string;
}) {
  return (
    <Input
      autoFocus
      defaultValue={(column.getFilterValue() as string | undefined) ?? ''}
      placeholder={placeholder ?? '包含…'}
      onChange={(e) => {
        const v = e.target.value;
        column.setFilterValue(v.trim() === '' ? undefined : v);
      }}
    />
  );
}

function RangeFilter<TData>({ column }: { column: Column<TData, unknown> }) {
  const v = (column.getFilterValue() as NumberRangeValue | undefined) ?? {};
  const set = (patch: NumberRangeValue) => {
    const next = { ...v, ...patch };
    column.setFilterValue(next.min || next.max ? next : undefined);
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        defaultValue={v.min ?? ''}
        placeholder="最小"
        className="h-8"
        onChange={(e) => set({ min: e.target.value })}
      />
      <span className="text-mute">—</span>
      <Input
        type="number"
        defaultValue={v.max ?? ''}
        placeholder="最大"
        className="h-8"
        onChange={(e) => set({ max: e.target.value })}
      />
    </div>
  );
}

function DateRangeFilter<TData>({ column }: { column: Column<TData, unknown> }) {
  return (
    <DateRangePicker
      value={column.getFilterValue() as DateRange | undefined}
      onChange={(r) => column.setFilterValue(r?.from || r?.to ? r : undefined)}
      placeholder="全部日期"
    />
  );
}
