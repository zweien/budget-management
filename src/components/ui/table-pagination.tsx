'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';

const DEFAULT_PAGE_SIZES = [50, 100, 200];

/**
 * 列表分页条(三处手写分页器的统一实现:全局录入/统计明细/审计日志)。
 * 左侧 leftHint(命中统计等),右侧 第 x/y 页 + 每页条数 + 上一页/下一页;
 * total 为 0 时不渲染右侧翻页器。
 */
export function TablePagination({
  page,
  pageSize,
  total,
  loading = false,
  onPageChange,
  onPageSizeChange,
  pageSizes = DEFAULT_PAGE_SIZES,
  leftHint,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizes?: number[];
  leftHint?: React.ReactNode;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
      <span>{leftHint ?? `共 ${total} 条`}</span>
      {total > 0 ? (
        <span className="flex items-center gap-2">
          <span>
            第 {page} / {pageCount} 页
          </span>
          <select
            className="h-8 rounded-md border border-border bg-card px-2 text-sm"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            disabled={loading}
            aria-label="每页条数"
          >
            {pageSizes.map((n) => (
              <option key={n} value={n}>
                {n} 条/页
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount || loading}
            onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          >
            下一页
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** 表格空态行(统一内联空态:单行 colspan 居中提示)。 */
export function TableEmpty({
  colSpan,
  children = '暂无数据',
}: {
  colSpan: number;
  children?: React.ReactNode;
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-32 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}
