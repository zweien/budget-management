'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SidebarBrand, SidebarFooter, SidebarNav } from '@/components/layout/app-sidebar';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { AuthWidget } from '@/components/auth/AuthWidget';

/** 与侧边栏 NAV 一致的顶层页面标签,用于面包屑第二级。 */
const PAGE_LABELS: Array<{ href: string; label: string }> = [
  { href: '/projects', label: '项目管理' },
  { href: '/records', label: '业务录入' },
  { href: '/approvals', label: '审批中心' },
  { href: '/statistics', label: '统计分析' },
  { href: '/audit-logs', label: '操作日志' },
  { href: '/api-keys', label: 'API 凭证' },
  { href: '/users', label: '用户管理' },
  { href: '/changelog', label: '更新日志' },
  { href: '/about', label: '关于' },
];

function useBreadcrumb() {
  const pathname = usePathname();
  if (pathname === '/') return null;
  // 项目子页在 ProjectShell 有专属条,面包屑只给到「项目管理」一级。
  return PAGE_LABELS.find(({ href }) => pathname.startsWith(href)) ?? null;
}

/**
 * IDRL topline:68px 高、画布底、hairline 底边;左侧轨道折叠开关 + 面包屑,
 * 右侧身份与主题工具;移动端为菜单按钮 + 模态抽屉。
 */
export function SiteHeader({
  version,
  collapsed,
  onToggleCollapse,
}: {
  version: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const crumb = useBreadcrumb();

  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-border bg-background px-4 lg:h-[68px] lg:gap-4 lg:px-7',
      )}
    >
      {/* 移动端抽屉导航(始终展开态) */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="打开导航菜单"
          onClick={() => setMobileOpen(true)}
        >
          <Menu />
        </Button>
        <SheetContent side="left" className="w-72 gap-0 p-6">
          <SheetTitle className="sr-only">导航菜单</SheetTitle>
          <SheetDescription className="sr-only">选择页面,或按 Esc 关闭导航。</SheetDescription>
          <div className="flex h-full flex-col">
            <SidebarBrand />
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
            <SidebarFooter version={version} onNavigate={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      {/* 桌面端轨道折叠开关(IDRL topline 位置) */}
      {onToggleCollapse ? (
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      ) : null}

      {/* 面包屑:应用名 → 顶层页面(当前页);移动端只留末级(IDRL 移动规则) */}
      <nav aria-label="页面路径" className="min-w-0">
        <ol className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
          <li className={cn(crumb && 'max-lg:hidden')}>
            <Link href="/" className="transition-colors outline-none hover:text-primary">
              工作区
            </Link>
          </li>
          {crumb ? (
            <>
              <li aria-hidden="true" className="flex max-lg:hidden">
                <ChevronRight className="size-3.5" />
              </li>
              <li className="min-w-0 truncate text-foreground">{crumb.label}</li>
            </>
          ) : null}
        </ol>
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <AuthWidget />
        <ThemeToggle />
      </div>
    </header>
  );
}
