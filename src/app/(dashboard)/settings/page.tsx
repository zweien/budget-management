'use client';

import { useEffect, useState } from 'react';

import { apiFetch } from '@/lib/api/client';
import { fetchSystemSettings } from '@/lib/api/systemSettings';
import type { SystemSettingsSnapshot } from '@/lib/system-settings';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { AppearanceCard } from '@/components/settings/appearance-card';
import { BrandCard } from '@/components/settings/brand-card';
import { WorkspaceCard } from '@/components/settings/workspace-card';

/**
 * 系统设置页(仅 ADMIN;CONTEXT.md「系统设置」)。
 * 三张卡片各自独立保存、互不覆盖;保存后其他页面在刷新或跳转时生效(不做实时推送)。
 * 非管理员不渲染表单(写接口另有服务端把关,这里的门控只是不让表单白屏报错)。
 */
export default function SettingsPage() {
  const [settings, setSettings] = useState<SystemSettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSystemSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '加载系统设置失败');
      });
    const syncMe = () => {
      apiFetch<{ role: string }>('/api/me')
        .then((me) => {
          if (!cancelled) setIsAdmin(me.role === 'ADMIN');
        })
        .catch(() => {
          if (!cancelled) setIsAdmin(false);
        });
    };
    syncMe();
    // MOCK 模式切换身份会派发 mock-user-change:切到非管理员时立即收起表单。
    window.addEventListener('mock-user-change', syncMe);
    return () => {
      cancelled = true;
      window.removeEventListener('mock-user-change', syncMe);
    };
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="ADMIN"
        title="系统设置"
        description="全实例统一的展示信息与界面默认值,修改会写入操作日志。个人在浏览器里做过的选择(主题、侧边栏折叠、分级线)仍优先于这里的默认值。"
      />

      {isAdmin === false ? (
        <Alert variant="error">
          <AlertTitle>无权访问</AlertTitle>
          <AlertDescription>系统设置仅管理员可查看和修改。</AlertDescription>
        </Alert>
      ) : loadError ? (
        <Alert variant="error">
          <AlertTitle>加载系统设置失败</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : !settings ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <BrandCard saved={settings} onSaved={setSettings} />
          <AppearanceCard saved={settings} onSaved={setSettings} />
          <WorkspaceCard saved={settings} onSaved={setSettings} />
        </div>
      )}
    </div>
  );
}
