'use client';

import * as React from 'react';

import { apiFetch } from '@/lib/api/client';
import { MockUserSelector } from '@/components/auth/MockUserSelector';
import { UserMenu } from '@/components/auth/UserMenu';
import { Skeleton } from '@/components/ui/skeleton';

interface Me {
  id: string;
  name: string;
  role: string;
  authMode: 'mock' | 'sso';
}

/**
 * 顶栏身份控件:SSO 模式渲染 UserMenu(姓名/角色/退出登录),
 * mock 模式渲染 MockUserSelector(开发用身份切换)。
 * 身份经 /api/me 拉取(apiFetch 在 SSO 401 时会自动跳登录页)。
 */
export function AuthWidget() {
  const [me, setMe] = React.useState<Me | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    apiFetch<Me>('/api/me')
      .then((u) => {
        if (!cancelled) setMe(u);
      })
      .catch(() => {
        // 401 时 apiFetch 已触发跳登录;其余错误保持骨架,不阻塞页面主体。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!me) {
    return <Skeleton className="h-8 w-40" />;
  }
  return me.authMode === 'sso' ? <UserMenu name={me.name} role={me.role} /> : <MockUserSelector />;
}
