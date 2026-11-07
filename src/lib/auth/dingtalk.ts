import { randomBytes } from 'node:crypto';

import { env } from '@/lib/env';

// 钉钉流程复用与 OIDC 相同的会话约定(Secure 推导 / returnTo 白名单 / cookie 常量)。
export {
  secureCookies,
  sanitizeReturnTo,
  AUTH_MODE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@/lib/auth/oidc';

/**
 * 钉钉 OAuth2(扫码/免密登录第三方网站)客户端。
 * 与 Authentik OIDC 平行的第二登录提供方,原生 fetch 实现(钉钉非标准 OIDC,
 * 无 discovery/id_token)。仅 SSO 模式(MOCK_AUTH=false)调用——env 校验保证
 * 启用 Provider 时凭证齐全。
 */

/** 钉钉流程暂存 cookie(state/returnTo),短寿命。 */
export const DINGTALK_FLOW_COOKIE = 'bm_dingtalk_flow';

/** 钉钉流程 cookie 时长:10 分钟(与 OIDC 流程一致)。 */
export const DINGTALK_FLOW_TTL_SECONDS = 10 * 60;

export interface DingtalkFlowState {
  state: string;
  returnTo: string;
}

/** 钉钉登录是否已配置(env 校验保证启用时 CLIENT_ID/SECRET 成对齐全)。 */
export function dingtalkEnabled(): boolean {
  return Boolean(env.DINGTALK_CLIENT_ID && env.DINGTALK_CLIENT_SECRET);
}

/** Authentik 是否已配置(登录页/路由按此条件渲染与守卫)。 */
export function authentikEnabled(): boolean {
  return Boolean(env.AUTHENTIK_ISSUER && env.AUTHENTIK_CLIENT_ID && env.AUTHENTIK_CLIENT_SECRET);
}

/** 授权码回调地址(需在钉钉开放平台应用的登录回调域名内)。 */
export function dingtalkRedirectUri(): string {
  return `${env.APP_BASE_URL}/api/auth/dingtalk/callback`;
}

/** 随机 state(防 CSRF;钉钉原样回传,不参与签名)。 */
export function randomDingtalkState(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * 构建钉钉扫码授权 URL。
 * redirect_uri 由 URL API 统一编码(含 `://` 的完整回调地址)。
 */
export function buildDingtalkAuthorizeUrl(state: string): URL {
  const url = new URL('https://login.dingtalk.com/oauth2/auth');
  url.searchParams.set('redirect_uri', dingtalkRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.DINGTALK_CLIENT_ID as string);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', state);
  // consent:每次进入授权确认页(默认免确认可能跳过用户视线)。
  url.searchParams.set('prompt', 'consent');
  return url;
}

export interface DingtalkTokens {
  accessToken: string;
  refreshToken: string;
  expireIn: number;
  /** 钉钉不返回 id_token,会话不含 IdP 终结凭据(登出走本地清理)。 */
}

/** 授权码换用户 accessToken;失败抛错(由回调路由兜底转登录页错误提示)。 */
export async function exchangeDingtalkCode(code: string): Promise<DingtalkTokens> {
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: env.DINGTALK_CLIENT_ID,
      clientSecret: env.DINGTALK_CLIENT_SECRET,
      code,
      grantType: 'authorization_code',
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`钉钉 userAccessToken 交换失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Partial<DingtalkTokens>;
  if (!data.accessToken) {
    throw new Error('钉钉 userAccessToken 响应缺少 accessToken');
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? '',
    expireIn: data.expireIn ?? 0,
  };
}

export interface DingtalkUser {
  nick: string | null;
  unionId: string;
  openId: string | null;
}

/** 以用户 accessToken 拉取个人信息;unionId 为建档主键(跨应用稳定)。 */
export async function fetchDingtalkUser(accessToken: string): Promise<DingtalkUser> {
  const res = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
    headers: { 'x-acs-dingtalk-access-token': accessToken },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`钉钉用户信息获取失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Partial<DingtalkUser>;
  if (!data.unionId) {
    throw new Error('钉钉用户信息缺少 unionId');
  }
  return {
    nick: data.nick ?? null,
    unionId: data.unionId,
    openId: data.openId ?? null,
  };
}

/**
 * 本地身份主键:命名空间化 unionId,与 Authentik sub 共用 users.auth_subject
 * 唯一列(同一人经两提供方登录为两个独立账号,不做自动关联)。
 */
export function dingtalkSubject(unionId: string): string {
  return `dingtalk:${unionId}`;
}
