import { NextRequest, NextResponse } from 'next/server';

import { env } from '@/lib/env';
import {
  buildDingtalkAuthorizeUrl,
  dingtalkEnabled,
  randomDingtalkState,
  secureCookies,
  sanitizeReturnTo,
  DINGTALK_FLOW_COOKIE,
  DINGTALK_FLOW_TTL_SECONDS,
  type DingtalkFlowState,
} from '@/lib/auth/dingtalk';

/**
 * GET /api/auth/dingtalk/login?returnTo=/x — 发起钉钉扫码登录授权码流程。
 * state 存短寿命 HttpOnly cookie(与 Authentik 流程同约定),302 到钉钉授权页。
 */
export async function GET(req: NextRequest) {
  // mock 模式不需要 SSO 登录,直接回首页(开发便利)。
  if (env.MOCK_AUTH) {
    return NextResponse.redirect(new URL('/', env.APP_BASE_URL));
  }
  // 凭证未配置(理论上 env 校验拦截了 SSO 模式下两组皆缺的场景,
  // 这里防仅配 Authentik 时直连本路径)。
  if (!dingtalkEnabled()) {
    const url = new URL('/login', env.APP_BASE_URL);
    url.searchParams.set('error', '钉钉登录未配置,请联系管理员');
    return NextResponse.redirect(url);
  }

  const flow: DingtalkFlowState = {
    state: randomDingtalkState(),
    returnTo: sanitizeReturnTo(req.nextUrl.searchParams.get('returnTo')),
  };

  const res = NextResponse.redirect(buildDingtalkAuthorizeUrl(flow.state));
  res.cookies.set(DINGTALK_FLOW_COOKIE, JSON.stringify(flow), {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    maxAge: DINGTALK_FLOW_TTL_SECONDS,
    path: '/',
  });
  return res;
}
