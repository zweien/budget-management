'use client';

import { useEffect, useRef, useState } from 'react';
import type { ColumnFiltersState, SortingState } from '@tanstack/react-table';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * §筛选状态 URL 同步(业务记录两页共用)。
 *
 * - 全部列筛选 + 排序打包为单个 `f` 参数(base64url JSON),`router.replace`
 *   回写(不堆浏览器历史);刷新/分享链接后筛选原样恢复。
 * - 进入时 `f` 优先;无 `f` 时回落到 legacyInit(兼容旧深链 ?subjectId=xx&year=yyyy
 *   与状态默认值),并在首次回写时把旧参数从 URL 中移除。
 * - dateRange 筛选值经 JSON 序列化后 from/to 变 ISO 字符串,还原时统一转回 Date
 *   (筛选器与日历组件按 Date 消费)。
 */

export interface UrlTableState {
  columnFilters: ColumnFiltersState;
  sorting: SortingState;
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** JSON 反序列化后把 dateRange 的 from/to(ISO 字符串)还原为 Date。 */
function reviveDateRanges(filters: ColumnFiltersState): ColumnFiltersState {
  return filters.map((f) => {
    if (!f.value || typeof f.value !== 'object' || Array.isArray(f.value)) return f;
    const v = f.value as Record<string, unknown>;
    if (!('from' in v || 'to' in v || 'empty' in v)) return f;
    return {
      ...f,
      value: {
        ...v,
        ...(typeof v.from === 'string' ? { from: new Date(v.from) } : {}),
        ...(typeof v.to === 'string' ? { to: new Date(v.to) } : {}),
      },
    };
  });
}

function parseStateFromUrl(code: string | null): UrlTableState | null {
  if (!code) return null;
  try {
    const raw = JSON.parse(fromBase64Url(code)) as Partial<UrlTableState>;
    if (!Array.isArray(raw.columnFilters) && !Array.isArray(raw.sorting)) return null;
    return {
      columnFilters: reviveDateRanges(raw.columnFilters ?? []),
      sorting: Array.isArray(raw.sorting) ? raw.sorting : [],
    };
  } catch {
    return null;
  }
}

function encodeState(state: UrlTableState): string | null {
  if (state.columnFilters.length === 0 && state.sorting.length === 0) return null;
  return toBase64Url(JSON.stringify(state));
}

export interface UrlSyncedTableState {
  columnFilters: ColumnFiltersState;
  sorting: SortingState;
  setColumnFilters: React.Dispatch<React.SetStateAction<ColumnFiltersState>>;
  setSorting: React.Dispatch<React.SetStateAction<SortingState>>;
}

/**
 * 筛选/排序状态持有 + URL 回写。页面用它替代裸 useState:
 * 初始值 = URL `f` 优先,否则 legacyInit(深链种子/默认筛选)。
 */
export function useUrlSyncedTableState(legacyInit: UrlTableState): UrlSyncedTableState {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // useState 初始化器只在首帧执行:URL `f` 优先,否则 legacy(深链种子/默认筛选)。
  // 后续以 React 状态为准,URL 由下方 effect 回写。
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    () => parseStateFromUrl(search.get('f'))?.columnFilters ?? legacyInit.columnFilters,
  );
  const [sorting, setSorting] = useState<SortingState>(
    () => parseStateFromUrl(search.get('f'))?.sorting ?? legacyInit.sorting,
  );

  const skipWriteBack = useRef(true);
  useEffect(() => {
    // 首帧不回写(保持外部传入的深链原样,如 legacy ?subjectId= 链接)。
    if (skipWriteBack.current) {
      skipWriteBack.current = false;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const code = encodeState({ columnFilters, sorting });
    if (code) params.set('f', code);
    else params.delete('f');
    // 筛选已并入 f,移除旧深链参数避免双份状态。
    params.delete('subjectId');
    params.delete('year');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [columnFilters, sorting, router, pathname]);

  return { columnFilters, sorting, setColumnFilters, setSorting };
}
