import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';

import { env } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { signSession } from '@/lib/auth/session';
import {
  dingtalkEnabled,
  dingtalkSubject,
  exchangeDingtalkCode,
  fetchDingtalkUser,
  sanitizeReturnTo,
  secureCookies,
  DINGTALK_FLOW_COOKIE,
  AUTH_MODE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type DingtalkFlowState,
} from '@/lib/auth/dingtalk';

function loginErrorRedirect(reason: string): NextResponse {
  const url = new URL('/login', env.APP_BASE_URL);
  url.searchParams.set('error', reason);
  const res = NextResponse.redirect(url);
  res.cookies.delete(DINGTALK_FLOW_COOKIE);
  return res;
}

/**
 * GET /api/auth/dingtalk/callback — 钉钉授权码回调。
 * 验 state → 换用户 accessToken → 取 unionId → 按 `dingtalk:<unionId>` JIT
 * 查/建本地用户(默认 USER)→ 签会话 cookie → 302 回 returnTo。
 * 钉钉无 id_token,会话不携带 IdP 终结凭据(登出走本地清理)。
 */
export async function GET(req: NextRequest) {
  if (env.MOCK_AUTH) {
    return NextResponse.redirect(new URL('/', env.APP_BASE_URL));
  }
  if (!dingtalkEnabled()) {
    return loginErrorRedirect('钉钉登录未配置,请联系管理员');
  }

  try {
    const rawFlow = req.cookies.get(DINGTALK_FLOW_COOKIE)?.value;
    if (!rawFlow) {
      return loginErrorRedirect('登录流程已过期,请重试');
    }
    const flow = JSON.parse(rawFlow) as DingtalkFlowState;

    // state 防 CSRF:钉钉原样回传,与流程 cookie 中的值比对。
    const state = req.nextUrl.searchParams.get('state');
    if (!state || state !== flow.state) {
      return loginErrorRedirect('登录状态校验失败,请重试');
    }
    const code = req.nextUrl.searchParams.get('code');
    if (!code) {
      return loginErrorRedirect('钉钉未返回授权码');
    }

    const tokens = await exchangeDingtalkCode(code);
    const profile = await fetchDingtalkUser(tokens.accessToken);

    // JIT 建档:首次登录自动建本地账号(默认普通用户;管理员用 scripts/make-admin.ts 提升)。
    // 身份主键命名空间化(dingtalk:<unionId>),与 Authentik sub 共用唯一列,
    // 同一人经两提供方登录为两个独立账号,不做自动关联。
    const subject = dingtalkSubject(profile.unionId);
    const user = await prisma.user.upsert({
      where: { authSubject: subject },
      // 显示名以本系统为准(管理员可在用户管理页改名),登录不回写钉钉昵称。
      update: {},
      create: { id: uuidv7(), authSubject: subject, name: profile.nick ?? subject, role: 'USER' },
    });
    if (user.status !== 'active') {
      return loginErrorRedirect('账号已停用,请联系管理员');
    }

    const sessionJwt = await signSession(user.id);
    const res = NextResponse.redirect(new URL(sanitizeReturnTo(flow.returnTo), env.APP_BASE_URL));
    res.cookies.set(SESSION_COOKIE, sessionJwt, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies(),
      maxAge: SESSION_TTL_SECONDS,
      path: '/',
    });
    // 非 HttpOnly 模式标记:客户端 apiFetch 据此跳过 mock bootstrap 探测。
    res.cookies.set(AUTH_MODE_COOKIE, 'sso', {
      sameSite: 'lax',
      secure: secureCookies(),
      maxAge: SESSION_TTL_SECONDS,
      path: '/',
    });
    res.cookies.delete(DINGTALK_FLOW_COOKIE);
    return res;
  } catch (e) {
    console.error('[auth] 钉钉 callback 处理失败:', e);
    return loginErrorRedirect('登录失败,请重试');
  }
}
