import { NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';
import { v7 as uuidv7 } from 'uuid';

import { env } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { signSession } from '@/lib/auth/session';
import {
  getOidcConfig,
  sanitizeReturnTo,
  OIDC_FLOW_COOKIE,
  AUTH_MODE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type OidcFlowState,
} from '@/lib/auth/oidc';

function loginErrorRedirect(reason: string): NextResponse {
  const url = new URL('/login', env.APP_BASE_URL);
  url.searchParams.set('error', reason);
  const res = NextResponse.redirect(url);
  res.cookies.delete(OIDC_FLOW_COOKIE);
  return res;
}

/**
 * GET /api/auth/callback — Authentik 授权码回调。
 * 验 state/nonce/PKCE → 按 OIDC sub JIT 查/建本地用户(默认 USER)
 * → 签会话 cookie → 302 回 returnTo。
 */
export async function GET(req: NextRequest) {
  if (env.MOCK_AUTH) {
    return NextResponse.redirect(new URL('/', env.APP_BASE_URL));
  }

  try {
    const rawFlow = req.cookies.get(OIDC_FLOW_COOKIE)?.value;
    if (!rawFlow) {
      return loginErrorRedirect('登录流程已过期,请重试');
    }
    const flow = JSON.parse(rawFlow) as OidcFlowState;

    const config = await getOidcConfig();
    // 注意:不能传 req.nextUrl(NextURL 非 URL 实例,v6 会拒绝),需显式构造。
    const tokens = await client.authorizationCodeGrant(config, new URL(req.url), {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims?.sub) {
      return loginErrorRedirect('身份令牌缺少 subject');
    }

    // JIT 建档:首次登录自动建本地账号(默认普通用户;管理员用 scripts/make-admin.ts 提升)。
    const displayName =
      (claims.preferred_username as string | undefined) ??
      (claims.name as string | undefined) ??
      claims.sub;
    const user = await prisma.user.upsert({
      where: { authSubject: claims.sub },
      // 名字跟随 IdP 更新。
      update: { name: displayName },
      create: { id: uuidv7(), authSubject: claims.sub, name: displayName, role: 'USER' },
    });
    if (user.status !== 'active') {
      return loginErrorRedirect('账号已停用,请联系管理员');
    }

    const sessionJwt = await signSession(user.id, tokens.id_token);
    const res = NextResponse.redirect(new URL(sanitizeReturnTo(flow.returnTo), env.APP_BASE_URL));
    res.cookies.set(SESSION_COOKIE, sessionJwt, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SECONDS,
      path: '/',
    });
    // 非 HttpOnly 模式标记:客户端 apiFetch 据此跳过 mock bootstrap 探测。
    res.cookies.set(AUTH_MODE_COOKIE, 'sso', {
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SECONDS,
      path: '/',
    });
    res.cookies.delete(OIDC_FLOW_COOKIE);
    return res;
  } catch (e) {
    console.error('[auth] callback 处理失败:', e);
    return loginErrorRedirect('登录失败,请重试');
  }
}
