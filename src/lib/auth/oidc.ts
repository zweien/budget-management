import * as client from 'openid-client';

import { env } from '@/lib/env';

/**
 * Authentik OIDC 客户端(discovery 结果进程内缓存)。
 * 仅 SSO 模式(MOCK_AUTH=false)调用——env 校验保证此刻四个变量齐全。
 */

let configPromise: Promise<client.Configuration> | null = null;

export function getOidcConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    const issuer = new URL(env.AUTHENTIK_ISSUER as string);
    // openid-client v6 默认仅允许 HTTPS;本地/内网 http 部署需在 discovery 请求时就放开
    // (config 还没建出来,事后再改已来不及),经 options.execute 注入。
    const options =
      issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined;
    configPromise = client.discovery(
      issuer,
      env.AUTHENTIK_CLIENT_ID as string,
      env.AUTHENTIK_CLIENT_SECRET as string,
      undefined,
      options,
    );
    // discovery 失败(如 Authentik 未启动)时清空缓存,下次调用重试。
    configPromise.catch(() => {
      configPromise = null;
    });
  }
  return configPromise;
}

/** 授权码回调地址(需在 Authentik provider 的 Redirect URIs 中登记)。 */
export function oidcRedirectUri(): string {
  return `${env.APP_BASE_URL}/api/auth/callback`;
}

/** OIDC 流程暂存 cookie(state/nonce/PKCE verifier/returnTo),短寿命。 */
export const OIDC_FLOW_COOKIE = 'bm_oidc_flow';

/** 会话 cookie(jose HS256 JWT,sub=本地用户 id)。 */
export const SESSION_COOKIE = 'bm_session';

/**
 * 认证模式标记 cookie(非 HttpOnly,仅作客户端提示):
 * sso 模式下 apiFetch 跳过 mock bootstrap 探测(避免 /api/users 401/403 噪音)。
 */
export const AUTH_MODE_COOKIE = 'bm_auth_mode';

/** 会话时长:8 小时。 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** OIDC 流程 cookie 时长:10 分钟(完成一次登录跳转足够)。 */
export const OIDC_FLOW_TTL_SECONDS = 10 * 60;

export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

/**
 * returnTo 白名单:仅允许站内绝对路径,防开放重定向。
 * 非法值回落到 '/'。
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw) return '/';
  // 必须以单个 / 开头;// 与 /\ 开头会被浏览器当协议相对/危险 URL。
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // 拒绝包含控制字符的输入。
  if (/[\u0000-\u001f]/.test(raw)) return '/';
  return raw;
}
