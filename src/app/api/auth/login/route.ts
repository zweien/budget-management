import { NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';

import { env } from '@/lib/env';
import {
  getOidcConfig,
  oidcRedirectUri,
  sanitizeReturnTo,
  secureCookies,
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_TTL_SECONDS,
  type OidcFlowState,
} from '@/lib/auth/oidc';

/**
 * GET /api/auth/login?returnTo=/x — 发起 Authentik SSO 授权码流程。
 * state/nonce/PKCE verifier 存短寿命 HttpOnly cookie,302 到 Authentik。
 */
export async function GET(req: NextRequest) {
  // mock 模式不需要 SSO 登录,直接回首页(开发便利)。
  if (env.MOCK_AUTH) {
    return NextResponse.redirect(new URL('/', env.APP_BASE_URL));
  }

  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get('returnTo'));

  let config: client.Configuration;
  try {
    config = await getOidcConfig();
  } catch (e) {
    // Authentik 不可达/provider 未配置:回登录页展示可读错误,而非裸 500。
    console.error('[auth] OIDC discovery 失败:', e);
    const url = new URL('/login', env.APP_BASE_URL);
    url.searchParams.set('error', '认证服务暂不可用,请联系管理员');
    return NextResponse.redirect(url);
  }

  const codeVerifier = client.randomPKCECodeVerifier();
  const flow: OidcFlowState = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier,
    returnTo,
  };

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: oidcRedirectUri(),
    scope: 'openid profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });

  const res = NextResponse.redirect(url);
  res.cookies.set(OIDC_FLOW_COOKIE, JSON.stringify(flow), {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    maxAge: OIDC_FLOW_TTL_SECONDS,
    path: '/',
  });
  return res;
}
