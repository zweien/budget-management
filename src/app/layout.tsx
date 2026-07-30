import '@ant-design/v5-patch-for-react-19';
import type { Metadata } from 'next';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import './globals.css';

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
    <html lang="zh-CN">
      <body>
        <ConfigProvider
          theme={{
            token: {
              colorPrimary: '#7c3aed', // 对齐原型紫色主题
              borderRadius: 4,
            },
          }}
          locale={zhCN}
        >
          {children}
        </ConfigProvider>
      </body>
    </html>
  );
}
