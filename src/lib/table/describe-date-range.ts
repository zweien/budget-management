import type { DateRangeFilterValue } from '@/lib/table/filter-fns';

/** 本地时区 yyyy-MM-dd(不用 toISOString:东八区本地午夜会回退一天)。 */
function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 日期筛选值的人话描述(供条件 chips 与导出前提示共用)。 */
export function describeDateRangeValue(v: unknown): string {
  const r = v as DateRangeFilterValue | undefined;
  if (!r) return '全部';
  if (r.empty) return '仅看无完成日期';
  const fmt = (d?: Date | string) => {
    if (!d) return '';
    const date = new Date(d);
    return Number.isNaN(date.getTime()) ? '' : toLocalDate(date);
  };
  const from = fmt(r.from);
  const to = fmt(r.to);
  if (from && to) return `${from} ~ ${to}`;
  if (from) return `≥ ${from}`;
  if (to) return `≤ ${to}`;
  return '全部';
}
