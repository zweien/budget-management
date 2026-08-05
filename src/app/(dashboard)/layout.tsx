import { cookies } from 'next/headers';

import pkg from '../../../package.json';
import { SIDEBAR_COLLAPSED_COOKIE } from '@/lib/ui-prefs';
import { DashboardShell } from '@/components/layout/dashboard-shell';

// Dashboard 下所有页面均依赖 mock 鉴权 header + 运行时数据拉取,不可静态预渲染。
export const dynamic = 'force-dynamic';

/**
 * Dashboard 外壳:固定侧边栏(lg+,可收缩为图标窄栏)+ 顶栏(移动端抽屉导航 / 身份选择 / 主题切换)。
 * 内容区不带卡片包裹,由各页自管表面(canvas / canvas-soft 分层)。
 * 折叠态(cookie)与版本号(package.json)由服务端注入,首屏无闪烁、无水合不一致。
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const collapsed = cookieStore.get(SIDEBAR_COLLAPSED_COOKIE)?.value === '1';

  return (
    <div className="min-h-screen bg-background">
      <DashboardShell defaultCollapsed={collapsed} version={pkg.version}>
        {children}
      </DashboardShell>
    </div>
  );
}
