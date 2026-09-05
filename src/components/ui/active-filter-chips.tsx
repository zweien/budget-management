'use client';

import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ColumnFiltersState } from '@tanstack/react-table';

interface ActiveFilterChipsProps {
  /** 当前生效的列筛选(TanStack columnFilters)。 */
  filters: ColumnFiltersState;
  /** 每列的人话描述:列 id + 筛选值 → chip 文本(如「科目: 设备费、材料费」)。 */
  describe: (columnId: string, value: unknown) => string;
  /** 列 id → 列名(用于 chip 前缀)。 */
  labels: Record<string, string>;
  onRemove: (columnId: string) => void;
  onClearAll: () => void;
}

/**
 * §当前生效筛选的条件 chips 行:表头上方逐条展示、可单个移除、一键清除全部。
 * 与表头漏斗是同一份 columnFilters 的两个视图,任一侧修改即时互同步。
 */
export function ActiveFilterChips({
  filters,
  describe,
  labels,
  onRemove,
  onClearAll,
}: ActiveFilterChipsProps) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-mute">筛选:</span>
      {filters.map((f) => (
        <span
          key={f.id}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card',
            'px-2 py-0.5 text-xs shadow-none',
          )}
        >
          <span className="text-mute">{labels[f.id] ?? f.id}:</span>
          <span className="max-w-72 truncate font-medium">{describe(f.id, f.value)}</span>
          <button
            type="button"
            aria-label={`移除筛选:${labels[f.id] ?? f.id}`}
            onClick={() => onRemove(f.id)}
            className="rounded-full p-0.5 text-mute transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-xs text-link underline-offset-4 transition-colors outline-none hover:text-link-deep hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        清除全部
      </button>
    </div>
  );
}
