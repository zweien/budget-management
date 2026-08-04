import { AppSidebar } from '@/components/layout/app-sidebar';
import { SiteHeader } from '@/components/layout/site-header';

// Dashboard 下所有页面均依赖 mock 鉴权 header + 运行时数据拉取,不可静态预渲染。
export const dynamic = 'force-dynamic';

/**
 * Dashboard 外壳:固定侧边栏(lg+)+ 顶栏(移动端抽屉导航 / 身份选择 / 主题切换)。
 * 内容区不带卡片包裹,由各页自管表面(canvas / canvas-soft 分层)。
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <AppSidebar />
      <div className="flex min-h-screen flex-col lg:pl-60">
        <SiteHeader />
        <main className="flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
