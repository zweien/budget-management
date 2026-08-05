'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { SIDEBAR_COLLAPSED_COOKIE } from '@/lib/ui-prefs';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { SiteHeader } from '@/components/layout/site-header';
import { TooltipProvider } from '@/components/ui/tooltip';

interface Props {
  /** 服务端从 cookie 读出的初始折叠态(首屏无闪烁)。 */
  defaultCollapsed: boolean;
  /** 包版本号(package.json),展示于侧边栏底部。 */
  version: string;
  children: React.ReactNode;
}

function writeCollapsedCookie(collapsed: boolean) {
  document.cookie = `${SIDEBAR_COLLAPSED_COOKIE}=${collapsed ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Dashboard 客户端壳:持有侧边栏折叠态,联动 aside 宽度与内容区 padding。
 * 折叠态写 cookie,服务端布局下次渲染时读出 → 刷新后保持。
 */
export function DashboardShell({ defaultCollapsed, version, children }: Props) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      writeCollapsedCookie(next);
      return next;
    });
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <AppSidebar collapsed={collapsed} version={version} onToggleCollapse={toggleCollapsed} />
      <div
        className={cn(
          'flex min-h-screen flex-col transition-[padding] duration-200',
          collapsed ? 'lg:pl-16' : 'lg:pl-60',
        )}
      >
        <SiteHeader version={version} />
        <main className="flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </TooltipProvider>
  );
}
