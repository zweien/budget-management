import type { FilterFn } from '@tanstack/react-table';

/**
 * 值清单「显式空集」哨兵:表头筛选取消全选时,客户端把它作为该维度的唯一值发往服务端,
 * 服务端归一化为「该维度匹配零行」(与 ValuesFilter 契约一致:取消全选=不显示任何行)。
 */
export const VALUES_FILTER_NONE = '__none__';

/**
 * TanStack Table 列筛选函数集(Excel 式表头筛选)。
 * 约定:undefined / 空串 / 空范围视为不过滤;
 * 值清单的 undefined=不过滤、显式空集=零行(见 multiSelectStrict 与 VALUES_FILTER_NONE)。
 */

/**
 * 值清单多选(旧语义:空数组=不过滤)。
 * ⚠️ 与 ValuesFilter「取消全选=显式空集→零行」的契约不一致,勿在新代码使用;
 * 新代码用 multiSelectStrict。
 */
export function multiSelect<T>(): FilterFn<T> {
  return (row, columnId, filterValue) => {
    if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
    return filterValue.includes(row.getValue(columnId));
  };
}

/**
 * 值清单多选(严格语义,与 ValuesFilter 契约一致):
 * undefined=未筛选(全过);显式数组按成员命中判断——取消全选的空集不显示任何行。
 */
export function multiSelectStrict<T>(): FilterFn<T> {
  return (row, columnId, filterValue) => {
    if (filterValue === undefined) return true;
    return (filterValue as unknown[]).includes(row.getValue(columnId));
  };
}

/** 文本包含(忽略大小写)。 */
export function textContains<T>(): FilterFn<T> {
  return (row, columnId, filterValue) => {
    const q = String(filterValue ?? '')
      .trim()
      .toLowerCase();
    if (!q) return true;
    return String(row.getValue(columnId) ?? '')
      .toLowerCase()
      .includes(q);
  };
}

export interface NumberRangeValue {
  min?: string;
  max?: string;
}

/** 数值范围(min/max 闭区间,字符串金额按 Number 解析)。 */
export function numberRange<T>(): FilterFn<T> {
  return (row, columnId, filterValue) => {
    const v = filterValue as NumberRangeValue | undefined;
    if (!v?.min && !v?.max) return true;
    const n = Number(row.getValue(columnId));
    if (!Number.isFinite(n)) return false;
    if (v?.min && n < Number(v.min)) return false;
    if (v?.max && n > Number(v.max)) return false;
    return true;
  };
}

/** 日期范围筛选值:起止区间,或「仅看空值」(如未回填的完成日期);二者互斥。 */
export interface DateRangeFilterValue {
  from?: Date | string;
  to?: Date | string;
  /** true = 只看该列为空的行(忽略 from/to)。 */
  empty?: boolean;
}

/** 日期范围(闭区间;行值为可解析日期字符串);empty=true 时只保留空值行。 */
export function dateRange<T>(): FilterFn<T> {
  return (row, columnId, filterValue) => {
    const r = filterValue as DateRangeFilterValue | undefined;
    if (!r) return true;
    if (r.empty) {
      const raw = row.getValue(columnId) as string | null | undefined;
      return raw == null || raw === '';
    }
    if (!r.from && !r.to) return true;
    const raw = row.getValue(columnId) as string;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return false;
    if (r.from) {
      const from = new Date(r.from);
      from.setHours(0, 0, 0, 0);
      if (d < from) return false;
    }
    if (r.to) {
      const to = new Date(r.to);
      to.setHours(23, 59, 59, 999);
      if (d > to) return false;
    }
    return true;
  };
}
