import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { KeyRound, QrCode } from 'lucide-react';

import { env } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/session';
import { authentikEnabled, dingtalkEnabled, sanitizeReturnTo } from '@/lib/auth/dingtalk';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

/**
 * 登录页(SSO 模式)。按已配置提供方渲染登录入口(Authentik / 钉钉可并存;
 * env 校验保证 SSO 模式下至少一组完整)。
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

  const showAuthentik = authentikEnabled();
  const showDingtalk = dingtalkEnabled();
  const subtitle = showDingtalk && !showAuthentik ? '使用钉钉扫码登录' : '使用单位统一身份认证登录';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8 shadow-l3">
        <div className="flex flex-col items-center gap-5 text-center">
          {/* 对外入口用 IDRL 双语组合字标(data-theme 驱动浅/深版本切换) */}
          <span className="relative block h-12 w-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/logo/lockup-bilingual.svg"
              alt="IDRL · 智能设计与鲁棒学习"
              className="brand-theme-light h-12 w-auto"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/logo/lockup-bilingual-reverse.svg"
              alt=""
              aria-hidden="true"
              className="brand-theme-dark h-12 w-auto"
            />
          </span>
          <div className="space-y-1">
            <h1 className="text-display-sm">预算管理系统</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        {error ? (
          <Alert variant="error">
            <AlertTitle>登录失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Suspense fallback={null}>
          <div className="space-y-3">
            {showDingtalk ? (
              <Button asChild className="w-full" size="lg">
                <a href={`/api/auth/dingtalk/login?returnTo=${encodeURIComponent(safeReturnTo)}`}>
                  <QrCode />
                  使用钉钉登录
                </a>
              </Button>
            ) : null}
            {showAuthentik ? (
              <Button
                asChild
                className="w-full"
                size="lg"
                variant={showDingtalk ? 'outline' : 'default'}
              >
                <a href={`/api/auth/login?returnTo=${encodeURIComponent(safeReturnTo)}`}>
                  <KeyRound />
                  使用 Authentik 登录
                </a>
              </Button>
            ) : null}
          </div>
        </Suspense>

        <p className="text-center text-xs text-mute">
          首次登录将自动创建本地账号(普通用户),权限由管理员分配
        </p>
      </div>
    </div>
  );
}
