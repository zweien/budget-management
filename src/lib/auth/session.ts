import { User } from '@prisma/client';
import { cookies, headers } from 'next/headers';
import { jwtVerify, SignJWT } from 'jose';

import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/auth/oidc';

function sessionSecret(): Uint8Array {
  // MOCK_AUTH=false 时 env 校验保证 AUTH_SECRET 存在且 ≥32 字符。
  return new TextEncoder().encode(env.AUTH_SECRET ?? '');
}

/** 签发出登录会话 JWT(sub=本地用户 id;id_token 供 RP-initiated 登出)。 */
export async function signSession(userId: string, idToken?: string): Promise<string> {
  const jwt = new SignJWT(idToken ? { id_token: idToken } : {})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`);
  return jwt.sign(sessionSecret());
}

/** 校验会话 JWT,返回本地用户 id 与 id_token;无效/过期返回 null。 */
export async function verifySession(
  token: string,
): Promise<{ userId: string; idToken?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (!payload.sub) return null;
    return { userId: payload.sub, idToken: payload.id_token as string | undefined };
  } catch {
    return null;
  }
}

/**
 * 获取当前用户。
 * - MOCK_AUTH=true:从 x-mock-user-id header 读取(本地开发/测试)。
 * - MOCK_AUTH=false(SSO):校验 bm_session JWT → 按 sub 实时查库
 *   (角色/停用状态即时生效,无需重新登录)。
 */
export async function getCurrentUser(): Promise<User | null> {
  if (env.MOCK_AUTH) {
    const h = await headers();
    const mockUserId = h.get('x-mock-user-id');
    if (!mockUserId) return null;
    return prisma.user.findUnique({ where: { id: mockUserId } });
  }

  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySession(token);
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status !== 'active') return null;
  return user;
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new HTTPError(401, '未登录或用户不存在');
  return user;
}

export class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
