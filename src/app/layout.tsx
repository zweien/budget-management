import type { Metadata } from 'next';

import './globals.css';

import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { getSystemSettingsSafe } from '@/server/services/systemSetting.service';

/** 标签页标题与描述取系统设置(CONTEXT.md「系统设置」);库不可达时按内置默认。 */
export async function generateMetadata(): Promise<Metadata> {
  const { title, subtitle } = await getSystemSettingsSafe();
  return { title, description: subtitle ?? title };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 默认主题:管理员设的是「该浏览器没有个人选择时」的初始主题,个人切过仍以个人为准。
  const { defaultTheme } = await getSystemSettingsSafe();

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {/* IDRL 主题协议:同时驱动 .dark(CSS 变体)与 data-theme(品牌 logo 切换) */}
        <ThemeProvider
          attribute={['class', 'data-theme']}
          defaultTheme={defaultTheme}
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
