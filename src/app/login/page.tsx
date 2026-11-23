import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { KeyRound, QrCode } from 'lucide-react';

import { env } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/session';
import { authentikEnabled, dingtalkEnabled, sanitizeReturnTo } from '@/lib/auth/dingtalk';
import { resolveLogoSrc } from '@/lib/system-settings';
import { SystemLogoImage } from '@/components/layout/brand';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getSystemSettingsSafe } from '@/server/services/systemSetting.service';

export const dynamic = 'force-dynamic';

/**
 * 登录页(SSO 模式)。按已配置提供方渲染登录入口(Authentik / 钉钉可并存;
 * env 校验保证 SSO 模式下至少一组完整)。
 * 已登录用户访问直接跳回 returnTo;mock 模式不需要本页(重定向首页)。
 * 标题、标志、底部提示与页脚取系统设置(认证前就要渲染,故读匿名可读的展示类设置)。
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
  const settings = await getSystemSettingsSafe();
  // 自定义标志:登录页用当前主题的版本(深色主题下有深色版用深色版)。
  const logoLight = resolveLogoSrc(settings.logos, { compact: false, dark: false });
  const logoDark = resolveLogoSrc(settings.logos, { compact: false, dark: true });

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8 shadow-l3">
        <div className="flex flex-col items-center gap-5 text-center">
          {logoLight || logoDark ? (
            <span className="relative block h-12 w-auto">
              <SystemLogoImage
                light={logoLight}
                dark={logoDark}
                alt={settings.title}
                className="h-12 w-auto max-w-64 object-contain"
              />
            </span>
          ) : (
            /* 对外入口用 IDRL 双语组合字标(data-theme 驱动浅/深版本切换) */
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
          )}
          <div className="space-y-1">
            <h1 className="text-display-sm">{settings.title}</h1>
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

        {settings.loginNotice ? (
          <p className="text-center text-xs text-mute">{settings.loginNotice}</p>
        ) : null}
      </div>
      {settings.footerText ? (
        <p className="mt-6 text-center text-xs text-mute">{settings.footerText}</p>
      ) : null}
    </div>
  );
}
