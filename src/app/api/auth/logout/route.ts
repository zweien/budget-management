import { NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';

import { env } from '@/lib/env';
import {
  OIDC_FLOW_COOKIE,
  SESSION_COOKIE,
  AUTH_MODE_COOKIE,
  clearAuthCookie,
  getOidcConfig,
  oidcFlowCookieName,
  sessionCookieName,
} from '@/lib/auth/oidc';
import { DINGTALK_FLOW_COOKIE, dingtalkFlowCookieName } from '@/lib/auth/dingtalk';
import { verifySession } from '@/lib/auth/session';

/**
 * GET /api/auth/logout — 退出登录。
 * 清本地会话 cookie,并尽量跳到 Authentik end-session 终结 SSO 会话
 * (带 id_token_hint;会话已过期等异常则只清本地,回 /login)。
 *
 * 安全加固(审计 bm1-web-logout-get-csrf):本路由是有状态变更的 GET(lax cookie
 * 会随跨站顶级导航携带),校验 Sec-Fetch-Site 拒绝跨站触发的强制登出
 * (同源 UI 与地址栏直接访问不受影响;现代浏览器均携带该头,缺失时放行兼容旧客户端)。
 */
export async function GET(req: NextRequest) {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return NextResponse.redirect(new URL('/', env.APP_BASE_URL));
  }

  const loginUrl = new URL('/login', env.APP_BASE_URL);
  if (env.MOCK_AUTH) {
    return NextResponse.redirect(new URL('/', env.APP_BASE_URL));
  }

  let target = loginUrl;
  const token = req.cookies.get(sessionCookieName())?.value;
  const session = token ? await verifySession(token) : null;
  if (session?.idToken) {
    try {
      const config = await getOidcConfig();
      target = client.buildEndSessionUrl(config, {
        id_token_hint: session.idToken,
        post_logout_redirect_uri: loginUrl.href,
      });
    } catch (e) {
      console.error('[auth] 构建 end-session URL 失败,仅清本地会话:', e);
    }
  }

  const res = NextResponse.redirect(target);
  // 清本代 cookie 名,并清 https 部署加上 `__Host-` 前缀之前下发的无前缀旧名(浏览器可能仍有残留)。
  for (const name of new Set([
    sessionCookieName(),
    oidcFlowCookieName(),
    dingtalkFlowCookieName(),
    SESSION_COOKIE,
    OIDC_FLOW_COOKIE,
    DINGTALK_FLOW_COOKIE,
  ])) {
    clearAuthCookie(res, name);
  }
  res.cookies.delete(AUTH_MODE_COOKIE);
  return res;
}
