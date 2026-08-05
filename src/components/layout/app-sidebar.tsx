'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChartColumn,
  ClipboardCheck,
  FolderKanban,
  LayoutDashboard,
  ScrollText,
  Wallet,
} from 'lucide-react';

import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', label: '工作台', icon: LayoutDashboard },
  { href: '/projects', label: '项目管理', icon: FolderKanban },
  { href: '/approvals', label: '审批中心', icon: ClipboardCheck },
  { href: '/statistics', label: '统计分析', icon: ChartColumn },
  { href: '/audit-logs', label: '操作日志', icon: ScrollText },
] as const;

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/**
 * 侧边栏导航内容(桌面 aside 与移动端 Sheet 共用)。
 * DESIGN.md ex-app-shell-row:active 用 primary 左缘指示条 + accent 底。
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5 px-3 py-4">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              active
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {active ? (
              <span className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
            ) : null}
            <Icon className="size-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <div className="flex h-16 items-center gap-2.5 border-b border-border px-4">
      <div className="flex size-6 items-center justify-center rounded-sm bg-primary text-primary-foreground">
        <Wallet className="size-3.5" />
      </div>
      <span className="text-sm font-semibold tracking-[-0.3px]">预算管理系统</span>
    </div>
  );
}

/** 桌面端固定侧边栏;<lg 隐藏(移动端由 site-header 的 Sheet 承载)。 */
export function AppSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-card lg:flex">
      <SidebarBrand />
      <SidebarNav />
    </aside>
  );
}
