import '@ant-design/v5-patch-for-react-19'; // 过渡保留:antd 静态方法的 React-19 patch,随 antd 一起删除
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import './globals.css';

import { ThemeProvider } from '@/components/theme-provider';
import { AntdBridge } from '@/components/antd-bridge';
import { Toaster } from '@/components/ui/sonner';

/* DESIGN.md 指定字体;中文字形经 globals.css --font-sans 回落系统字体 */
const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

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
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AntdBridge>{children}</AntdBridge>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
