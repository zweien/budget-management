'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChartColumn,
  ClipboardCheck,
  ClipboardPlus,
  FolderKanban,
  Info,
  KeyRound,
  LayoutDashboard,
  NotebookText,
  ScrollText,
  UserCog,
  Wallet,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api/client';
import { Brand } from '@/components/layout/brand';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const WORKSPACE_GROUP = {
  id: 'workspace',
  label: '工作区',
  items: [
    { href: '/', label: '工作台', icon: LayoutDashboard },
    { href: '/projects', label: '项目管理', icon: FolderKanban },
    { href: '/records', label: '业务录入', icon: ClipboardPlus },
    { href: '/approvals', label: '审批中心', icon: ClipboardCheck },
    { href: '/statistics', label: '统计分析', icon: ChartColumn },
  ],
} as const;

const SYSTEM_GROUP = {
  id: 'system',
  label: '系统',
  items: [
    { href: '/audit-logs', label: '操作日志', icon: ScrollText },
    { href: '/api-keys', label: 'API 凭证', icon: KeyRound },
  ],
} as const;

const CHANGELOG_ITEM = { href: '/changelog', label: '更新日志', icon: NotebookText } as const;
const ABOUT_ITEM = { href: '/about', label: '关于', icon: Info } as const;
/** 仅管理员可见(经 /api/me 判定;MOCK 模式随身份切换即时显隐)。 */
const ADMIN_NAV_ITEM = { href: '/users', label: '用户管理', icon: UserCog } as const;

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
        'relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'bg-card font-bold text-foreground shadow-[inset_3px_0_0_0_var(--primary)]'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        collapsed && 'w-12 justify-center px-0',
      )}
    >
      <Icon className="size-[19px] shrink-0" aria-hidden="true" />
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

function NavGroup({
  label,
  children,
  collapsed,
}: {
  label: string;
  children: React.ReactNode;
  collapsed?: boolean;
}) {
  return (
    <div
      className={cn(
        'grid gap-1.5',
        collapsed && 'pt-5 not-first:border-t not-first:border-border not-first:pt-5',
      )}
    >
      <p
        className={cn(
          'mb-1.5 px-3 text-xs tracking-[0.12em] text-muted-foreground',
          collapsed && 'sr-only',
        )}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * 侧边栏导航内容(桌面 aside 与移动端 Sheet 共用)。
 * IDRL AppShell 导航:分组 + 组标签,active 为 surface 底 + 3px primary 内嵌左缘 + 加粗。
 */
export function SidebarNav({ collapsed, onNavigate }: NavState) {
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const sync = () => {
      apiFetch<{ role: string }>('/api/me')
        .then((me) => {
          if (!cancelled) setIsAdmin(me.role === 'ADMIN');
        })
        .catch(() => {
          if (!cancelled) setIsAdmin(false);
        });
    };
    sync();
    // MOCK 模式切换身份会派发 mock-user-change(codex P2):随身份即时显隐。
    window.addEventListener('mock-user-change', sync);
    return () => {
      cancelled = true;
      window.removeEventListener('mock-user-change', sync);
    };
  }, []);

  const systemItems = isAdmin ? [...SYSTEM_GROUP.items, ADMIN_NAV_ITEM] : [...SYSTEM_GROUP.items];

  return (
    <nav
      aria-label="工作空间导航"
      className={cn('flex flex-col gap-7 py-6', collapsed ? 'px-3' : 'px-4')}
    >
      <NavGroup label={WORKSPACE_GROUP.label} collapsed={collapsed}>
        {WORKSPACE_GROUP.items.map(({ href, label, icon }) => (
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
      </NavGroup>
      <NavGroup label={SYSTEM_GROUP.label} collapsed={collapsed}>
        {systemItems.map(({ href, label, icon }) => (
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
      </NavGroup>
    </nav>
  );
}

/** 品牌区:IDRL 字标(窄栏用 symbol)+ 应用名空间标签(IDRL space-label)。 */
export function SidebarBrand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className={cn('pt-7', collapsed ? 'pb-2' : 'px-1 pb-6')}>
      <Link
        href="/"
        aria-label="返回工作台"
        className={cn(
          'block outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          collapsed && 'mx-auto w-fit',
        )}
      >
        <Brand compact={collapsed} />
        {collapsed ? <span className="sr-only">预算管理系统</span> : null}
      </Link>
      {!collapsed ? (
        <div className="mt-7 flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted font-bold text-primary">
            <Wallet className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <strong className="block text-xs leading-4">预算管理系统</strong>
            <span className="block text-xs leading-4 text-muted-foreground">科研项目预算管理</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

interface FooterProps extends NavState {
  /** 包版本号(package.json),由服务端布局注入。 */
  version: string;
}

/** 底栏:关于 + 更新日志入口 + 版本号。 */
export function SidebarFooter({ collapsed, version, onNavigate }: FooterProps) {
  const pathname = usePathname();
  const changelogActive = isActive(pathname, CHANGELOG_ITEM.href);
  const aboutActive = isActive(pathname, ABOUT_ITEM.href);

  return (
    <div className={cn('mt-auto pb-5', collapsed ? 'px-3' : 'px-4')}>
      <div
        className={cn('grid gap-1.5 border-t border-border pt-5', collapsed && 'border-t-0 pt-0')}
      >
        <NavLink
          href={ABOUT_ITEM.href}
          label={ABOUT_ITEM.label}
          icon={ABOUT_ITEM.icon}
          active={aboutActive}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
        <NavLink
          href={CHANGELOG_ITEM.href}
          label={CHANGELOG_ITEM.label}
          icon={CHANGELOG_ITEM.icon}
          active={changelogActive}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>
      {collapsed ? (
        <div className="mt-2 flex flex-col items-center gap-1">
          {/* 窄栏下版本号缩为 10px mono,保持可见。 */}
          <span className="font-mono text-[10px] leading-none text-mute">v{version}</span>
        </div>
      ) : (
        <div className="mt-2 px-3 py-1">
          <span className="text-xs text-mute">v{version}</span>
        </div>
      )}
    </div>
  );
}

interface AppSidebarProps {
  collapsed: boolean;
  version: string;
}

/** 桌面端固定侧边栏(IDRL 轨道:展开 240px / 窄栏 72px 图标);<lg 隐藏(移动端由 site-header 的 Sheet 承载)。 */
export function AppSidebar({ collapsed, version }: AppSidebarProps) {
  return (
    <aside
      aria-label="应用侧边栏"
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden flex-col overflow-y-auto bg-background transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[72px] px-3 py-5' : 'w-60 px-4 py-5',
      )}
    >
      <SidebarBrand collapsed={collapsed} />
      <SidebarNav collapsed={collapsed} />
      <SidebarFooter collapsed={collapsed} version={version} />
    </aside>
  );
}
