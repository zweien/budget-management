import { NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';

import { env } from '@/lib/env';
import { getOidcConfig, OIDC_FLOW_COOKIE, SESSION_COOKIE, AUTH_MODE_COOKIE } from '@/lib/auth/oidc';
import { verifySession } from '@/lib/auth/session';

/**
 * GET /api/auth/logout — 退出登录。
 * 清本地会话 cookie,并尽量跳到 Authentik end-session 终结 SSO 会话
 * (带 id_token_hint;会话已过期等异常则只清本地,回 /login)。
 */
export async function GET(req: NextRequest) {
  const loginUrl = new URL('/login', env.APP_BASE_URL);
  if (env.MOCK_AUTH) {
    return NextResponse.redirect(new URL('/', env.APP_BASE_URL));
  }

  let target = loginUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
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
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(AUTH_MODE_COOKIE);
  res.cookies.delete(OIDC_FLOW_COOKIE);
  return res;
}
