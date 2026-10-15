import type { Metadata } from 'next';

import './globals.css';

import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: '预算管理系统',
  description: '科研项目预算管理系统',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {/* IDRL 主题协议:同时驱动 .dark(CSS 变体)与 data-theme(品牌 logo 切换) */}
        <ThemeProvider
          attribute={['class', 'data-theme']}
          defaultTheme="system"
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
