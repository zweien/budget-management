'use client';

import * as React from 'react';

import {
  EMPTY_LOGO_MAP,
  mergeSystemSettings,
  type SystemSettingsSnapshot,
} from '@/lib/system-settings';

const SystemSettingsContext = React.createContext<SystemSettingsSnapshot | null>(null);

/** Provider 缺席时的回落值:模块级常量,保证依赖它的 effect 不会因每次渲染换引用而重跑。 */
const FALLBACK_SETTINGS: SystemSettingsSnapshot = {
  ...mergeSystemSettings(null),
  logos: EMPTY_LOGO_MAP,
};

/**
 * 系统设置 Provider:dashboard 布局(服务端)读出生效值后注入,壳内客户端组件同步取用——
 * 侧边栏标题/标志、台账默认口径、分级线默认值首屏即按设置渲染,无闪烁、无额外请求。
 * Provider 缺席时(不经 dashboard 布局的组件)回落出厂默认。
 */
export function SystemSettingsProvider({
  settings,
  children,
}: {
  settings: SystemSettingsSnapshot;
  children: React.ReactNode;
}) {
  return (
    <SystemSettingsContext.Provider value={settings}>{children}</SystemSettingsContext.Provider>
  );
}

/** 当前生效的系统设置(CONTEXT.md「系统设置」)。 */
export function useSystemSettings(): SystemSettingsSnapshot {
  return React.useContext(SystemSettingsContext) ?? FALLBACK_SETTINGS;
}
