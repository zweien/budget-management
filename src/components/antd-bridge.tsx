'use client';

import * as React from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useTheme } from 'next-themes';

/**
 * 过渡兼容层(全量迁移完成后随 antd 一起删除,见重构计划 §8):
 * 未迁移的 antd 页面在暗色主题下切换 antd darkAlgorithm,避免旧页裸奔。
 * mounted 前固定 light,避免服务端/客户端首帧不一致。
 */
export function AntdBridge({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    // mounted 守卫是 hydration 安全的标准做法(首帧须与服务端一致),
    // 无级联渲染风险,禁用 set-state-in-effect(与本仓 MockUserSelector 同例)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const dark = mounted && resolvedTheme === 'dark';

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#7c3aed', // 旧页沿用原紫色主题,直到逐页迁移
          borderRadius: 4,
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
