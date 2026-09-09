'use client';

import * as React from 'react';
import { Settings2 } from 'lucide-react';
import type { VisibilityState } from '@tanstack/react-table';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface ColumnSettingItem {
  id: string;
  label: string;
}

/**
 * 列设置弹层(与执行台账 BudgetTreeTable 同款交互):勾选控制表格列显隐。
 * 搭配 useStoredColumnVisibility 使用——偏好按 key 隔离存 localStorage。
 * TanStack 表格以受控 state 接 columnVisibility 即可(popper 触发 toggle)。
 */
export function ColumnSettingsPopover({
  items,
  columnVisibility,
  onToggle,
}: {
  items: ColumnSettingItem[];
  /** TanStack columnVisibility:{ 列id: 是否显示 };未出现的列默认显示。 */
  columnVisibility: VisibilityState;
  onToggle: (id: string, visible: boolean) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 />
          列设置
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44">
        <p className="caption-mono mb-2">显示列设置</p>
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {items.map((c) => {
            const visible = columnVisibility[c.id] !== false;
            return (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={visible}
                  onCheckedChange={(checked) => onToggle(c.id, checked === true)}
                />
                {c.label}
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 列显隐偏好(按 key 隔离存 localStorage;仅在勾选时写盘,挂载即读)。
 * 返回 [显隐状态, 单列切换]。
 */
export function useStoredColumnVisibility(
  key: string,
): [VisibilityState, (id: string, visible: boolean) => void] {
  // SSR 首渲与客户端水合都必须是「全部显示」(codex P2):偏好挂载后下一帧再应用,
  // requestAnimationFrame 派发以通过 set-state-in-effect 规则。
  const [state, setState] = React.useState<VisibilityState>({});
  React.useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: VisibilityState;
    try {
      parsed = JSON.parse(raw) as VisibilityState;
    } catch {
      return;
    }
    const raf = requestAnimationFrame(() => setState(parsed));
    return () => cancelAnimationFrame(raf);
  }, [key]);
  const toggle = React.useCallback(
    (id: string, visible: boolean) => {
      setState((prev) => {
        const next = { ...prev, [id]: visible };
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* 存储失败不影响功能 */
        }
        return next;
      });
    },
    [key],
  );
  return [state, toggle];
}
