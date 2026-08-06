import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { KeyRound, Wallet } from 'lucide-react';

import { env } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/session';
import { sanitizeReturnTo } from '@/lib/auth/oidc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

/**
 * 登录页(SSO 模式)。
 * 已登录用户访问直接跳回 returnTo;mock 模式不需要本页(重定向首页)。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const { error, returnTo } = await searchParams;
  const safeReturnTo = sanitizeReturnTo(returnTo);

  if (env.MOCK_AUTH) {
    redirect('/');
  }
  if (await getCurrentUser()) {
    redirect(safeReturnTo);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8 shadow-l3">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Wallet className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-display-sm">预算管理系统</h1>
            <p className="text-sm text-muted-foreground">使用单位统一身份认证(Authentik)登录</p>
          </div>
        </div>

        {error ? (
          <Alert variant="error">
            <AlertTitle>登录失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Suspense fallback={null}>
          <Button asChild className="w-full" size="lg">
            <a href={`/api/auth/login?returnTo=${encodeURIComponent(safeReturnTo)}`}>
              <KeyRound />
              使用 Authentik 登录
            </a>
          </Button>
        </Suspense>

        <p className="caption-mono text-center text-mute">
          首次登录将自动创建本地账号(普通用户),权限由管理员分配
        </p>
      </div>
    </div>
  );
}
