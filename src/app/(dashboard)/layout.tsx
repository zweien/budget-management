import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import pkg from '../../../package.json';
import { env } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/session';
import { COLUMN_PREFS_COOKIE, SIDEBAR_COLLAPSED_COOKIE, parseColumnPrefs } from '@/lib/ui-prefs';
import { ColumnPrefsProvider } from '@/components/ui/column-settings';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { SystemSettingsProvider } from '@/components/layout/system-settings-provider';
import { getSystemSettingsSafe } from '@/server/services/systemSetting.service';

// Dashboard 下所有页面均依赖 mock 鉴权 header + 运行时数据拉取,不可静态预渲染。
export const dynamic = 'force-dynamic';

/**
 * Dashboard 外壳:固定侧边栏(lg+,可收缩为图标窄栏)+ 顶栏(移动端抽屉导航 / 身份选择 / 主题切换)。
 * 内容区不带卡片包裹,由各页自管表面(canvas / canvas-soft 分层)。
 * 折叠态(cookie)与版本号(package.json)由服务端注入,首屏无闪烁、无水合不一致。
 * 列显隐偏好同样走 cookie(Provider 注入),表格首屏按偏好渲染,不再「先全列闪再收窄」。
 * 系统设置(标题/标志/各默认值)由服务端读出经 Provider 注入,壳内组件同步取用。
 * SSO 模式服务端门岗:未登录一律重定向 /login(API 层另有 requireUser 兜底)。
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!env.MOCK_AUTH && !(await getCurrentUser())) {
    redirect('/login');
  }

  const cookieStore = await cookies();
  const columnPrefs = parseColumnPrefs(cookieStore.get(COLUMN_PREFS_COOKIE)?.value);
  // 侧边栏折叠:个人点过以 cookie 为准,没点过跟随系统默认(个人偏好优先于系统默认)。
  const collapsedCookie = cookieStore.get(SIDEBAR_COLLAPSED_COOKIE)?.value;
  const settings = await getSystemSettingsSafe();
  const collapsed =
    collapsedCookie === undefined ? settings.sidebarCollapsed : collapsedCookie === '1';

  return (
    <div className="min-h-screen bg-background">
      <SystemSettingsProvider settings={settings}>
        <ColumnPrefsProvider initialPrefs={columnPrefs}>
          <DashboardShell defaultCollapsed={collapsed} version={pkg.version}>
            {children}
          </DashboardShell>
        </ColumnPrefsProvider>
      </SystemSettingsProvider>
    </div>
  );
}
