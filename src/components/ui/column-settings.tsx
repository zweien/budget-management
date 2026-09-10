'use client';

import * as React from 'react';
import { Settings2 } from 'lucide-react';
import type { VisibilityState } from '@tanstack/react-table';

import { writeColumnPrefToDocument } from '@/lib/ui-prefs';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface ColumnSettingItem {
  id: string;
  label: string;
}

/**
 * 列设置弹层(与执行台账 BudgetTreeTable 同款交互):勾选控制表格列显隐。
 * 搭配 useStoredColumnVisibility 使用——偏好按 key 隔离,cookie 持久化
 * (服务端布局读出 → 首屏无闪烁、无水合不一致,与侧边栏折叠同款方案)。
 * TanStack 表格以受控 state 接 columnVisibility 即可(popper 触发 toggle);
 * 手写表格以 colVisible(id) 条件渲染。
 */
export function ColumnSettingsPopover({
  items,
  columnVisibility,
  onToggle,
}: {
  items: ColumnSettingItem[];
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

interface ColumnPrefsStore {
  prefs: Record<string, VisibilityState>;
  setPref: (key: string, visibility: VisibilityState) => void;
}

const ColumnPrefsContext = React.createContext<ColumnPrefsStore | null>(null);

/**
 * 列显隐偏好 Provider:dashboard 布局(服务端)读 cookie 后注入初始值,
 * 客户端首渲即拿到真实偏好 → SSR HTML 与水合输出一致,表格不再「先全列闪再收窄」。
 */
export function ColumnPrefsProvider({
  initialPrefs,
  children,
}: {
  initialPrefs: Record<string, VisibilityState>;
  children: React.ReactNode;
}) {
  const [prefs, setPrefs] = React.useState<Record<string, VisibilityState>>(initialPrefs);
  const setPref = React.useCallback((key: string, visibility: VisibilityState) => {
    setPrefs((prev) => ({ ...prev, [key]: visibility }));
    writeColumnPrefToDocument(key, visibility);
  }, []);
  const store = React.useMemo(() => ({ prefs, setPref }), [prefs, setPref]);
  return <ColumnPrefsContext.Provider value={store}>{children}</ColumnPrefsContext.Provider>;
}

/**
 * 列显隐偏好(按 key 隔离;cookie 持久化,Provider 注入首渲值)。
 * 返回 [显隐状态, 单列切换]。
 * 兼容:Provider 缺席时回落 localStorage + rAF(旧行为);
 * Provider 在场但该 key 尚无偏好时,一次性迁移旧 localStorage 值到 cookie(迁移后移除)。
 */
export function useStoredColumnVisibility(
  key: string,
): [VisibilityState, (id: string, visible: boolean) => void] {
  const store = React.useContext(ColumnPrefsContext);

  // —— Provider 缺席的回落路径(与旧实现一致):SSR 首渲全显,rAF 应用 localStorage ——
  const [fallback, setFallback] = React.useState<VisibilityState>({});
  React.useEffect(() => {
    if (store !== null) return;
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
    const raf = requestAnimationFrame(() => setFallback(parsed));
    return () => cancelAnimationFrame(raf);
  }, [key, store]);

  // —— 一次性迁移:cookie 无该 key 且 localStorage 有 → 写 cookie、清 localStorage ——
  React.useEffect(() => {
    if (store === null) return;
    if (store.prefs[key] !== undefined) return;
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
    // 客户端直写 cookie(Provider 注入值来自服务端,不含本次迁移);
    // rAF 派发 context 更新以通过 set-state-in-effect 规则——值与 SSR 一致,无视觉跳动。
    const raf = requestAnimationFrame(() => {
      writeColumnPrefToDocument(key, parsed);
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* 忽略 */
      }
      store.setPref(key, parsed);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在挂载/该 key 首次缺偏好时迁移一次
  }, [key, store?.prefs[key]]);

  const visibility: VisibilityState = store ? (store.prefs[key] ?? {}) : fallback;

  const toggle = React.useCallback(
    (id: string, visible: boolean) => {
      if (store) {
        store.setPref(key, { ...(store.prefs[key] ?? {}), [id]: visible });
        return;
      }
      setFallback((prev) => {
        const next = { ...prev, [id]: visible };
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* 存储失败不影响功能 */
        }
        return next;
      });
    },
    [key, store],
  );

  return [visibility, toggle];
}
