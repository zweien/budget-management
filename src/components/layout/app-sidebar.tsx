'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  ClipboardPlus,
  FolderKanban,
  LayoutDashboard,
  NotebookText,
  ScrollText,
  Wallet,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const NAV_ITEMS = [
  { href: '/', label: '工作台', icon: LayoutDashboard },
  { href: '/projects', label: '项目管理', icon: FolderKanban },
  { href: '/records', label: '业务录入', icon: ClipboardPlus },
  { href: '/approvals', label: '审批中心', icon: ClipboardCheck },
  { href: '/statistics', label: '统计分析', icon: ChartColumn },
  { href: '/audit-logs', label: '操作日志', icon: ScrollText },
] as const;

const CHANGELOG_ITEM = { href: '/changelog', label: '更新日志', icon: NotebookText } as const;

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

interface NavState {
  /** 桌面窄栏模式:仅图标,label 进 tooltip 与 sr-only。 */
  collapsed?: boolean;
  onNavigate?: () => void;
}

/** 单个导航链接;collapsed 时图标居中 + 右侧 tooltip。 */
function NavLink({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const link = (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        'relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'bg-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      {active ? (
        <span className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      ) : null}
      <Icon className="size-4 shrink-0" />
      {collapsed ? <span className="sr-only">{label}</span> : label}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 侧边栏导航内容(桌面 aside 与移动端 Sheet 共用)。
 * DESIGN.md ex-app-shell-row:active 用 primary 左缘指示条 + accent 底。
 */
export function SidebarNav({ collapsed, onNavigate }: NavState) {
  const pathname = usePathname();

  return (
    <nav className={cn('flex flex-col gap-0.5 py-4', collapsed ? 'px-2' : 'px-3')}>
      {NAV_ITEMS.map(({ href, label, icon }) => (
        <NavLink
          key={href}
          href={href}
          label={label}
          icon={icon}
          active={isActive(pathname, href)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

export function SidebarBrand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div
      className={cn(
        'flex h-16 items-center gap-2.5 border-b border-border',
        collapsed ? 'justify-center px-2' : 'px-4',
      )}
    >
      <div className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground">
        <Wallet className="size-3.5" />
      </div>
      {collapsed ? (
        <span className="sr-only">预算管理系统</span>
      ) : (
        <span className="text-sm font-semibold tracking-[-0.3px]">预算管理系统</span>
      )}
    </div>
  );
}

interface FooterProps extends NavState {
  /** 包版本号(package.json),由服务端布局注入。 */
  version: string;
  /** 桌面端折叠切换;移动端 Sheet 不展示该按钮。 */
  onToggleCollapse?: () => void;
}

/** 底栏:更新日志入口 + 版本号 + 折叠开关(仅桌面)。 */
export function SidebarFooter({ collapsed, version, onNavigate, onToggleCollapse }: FooterProps) {
  const pathname = usePathname();
  const changelogActive = isActive(pathname, CHANGELOG_ITEM.href);
  const ToggleIcon = collapsed ? ChevronsRight : ChevronsLeft;

  const toggleButton = onToggleCollapse ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          onClick={onToggleCollapse}
          className="text-mute hover:text-foreground"
        >
          <ToggleIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{collapsed ? '展开侧边栏' : '收起侧边栏'}</TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <div className={cn('mt-auto border-t border-border py-3', collapsed ? 'px-2' : 'px-3')}>
      <NavLink
        href={CHANGELOG_ITEM.href}
        label={CHANGELOG_ITEM.label}
        icon={CHANGELOG_ITEM.icon}
        active={changelogActive}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
      {collapsed ? (
        <div className="mt-2 flex flex-col items-center gap-1">
          {/* 窄栏下版本号缩为 10px mono,保持可见。 */}
          <span className="font-mono text-[10px] leading-none text-mute">v{version}</span>
          {toggleButton}
        </div>
      ) : (
        <div className="mt-1 flex items-center justify-between px-3 py-1">
          <span className="caption-mono text-mute">v{version}</span>
          {toggleButton}
        </div>
      )}
    </div>
  );
}

interface AppSidebarProps {
  collapsed: boolean;
  version: string;
  onToggleCollapse: () => void;
}

/** 桌面端固定侧边栏(可收缩为 w-16 图标窄栏);<lg 隐藏(移动端由 site-header 的 Sheet 承载)。 */
export function AppSidebar({ collapsed, version, onToggleCollapse }: AppSidebarProps) {
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-card transition-[width] duration-200 lg:flex',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <SidebarBrand collapsed={collapsed} />
      <SidebarNav collapsed={collapsed} />
      <SidebarFooter collapsed={collapsed} version={version} onToggleCollapse={onToggleCollapse} />
    </aside>
  );
}
