import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * https 部署下认证 cookie 的路由级行为(环境自足,同 authDingtalkCallback.route.test.ts):
 * 会话与登录流程 cookie 带 `__Host-` 前缀——浏览器只接受本站下发的 Secure + Path=/ 且
 * 不带 Domain 的此类 cookie,同一可注册域下的兄弟子域无法再覆盖它们(cookie tossing /
 * 登录 CSRF),清除时下发的过期头必须同样带 Secure。
 */
const MUTATED_KEYS = [
  'MOCK_AUTH',
  'DINGTALK_CLIENT_ID',
  'DINGTALK_CLIENT_SECRET',
  'APP_BASE_URL',
] as const;
const saved = Object.fromEntries(MUTATED_KEYS.map((key) => [key, process.env[key]]));
process.env.DATABASE_URL ??= 'postgresql://vitest:vitest@localhost:5432/vitest';
process.env.MOCK_AUTH = 'false';
process.env.DINGTALK_CLIENT_ID = 'ding-route-key';
process.env.DINGTALK_CLIENT_SECRET = 'ding-route-secret';
process.env.APP_BASE_URL = 'https://budget.example';
afterAll(() => {
  for (const key of MUTATED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// 请求 Cookie 头由各用例注入(getCurrentUser 经 next/headers 读取)。
const requestCookies = vi.hoisted(() => ({ header: '' }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => {
    const jar = new Map<string, string>();
    for (const part of requestCookies.header.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) jar.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1)));
    }
    return { get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) };
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { upsert: vi.fn(), findUnique: vi.fn() } },
}));

// 仅替换网络出口(token 交换/取用户信息),命名与纯函数保留真实实现。
vi.mock('@/lib/auth/dingtalk', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/dingtalk')>)();
  return { ...actual, exchangeDingtalkCode: vi.fn(), fetchDingtalkUser: vi.fn() };
});

const { GET: dingtalkLogin } = await import('@/app/api/auth/dingtalk/login/route');
const { GET: dingtalkCallback } = await import('@/app/api/auth/dingtalk/callback/route');
const { GET: logout } = await import('@/app/api/auth/logout/route');
const { exchangeDingtalkCode, fetchDingtalkUser, dingtalkFlowCookieName } =
  await import('@/lib/auth/dingtalk');
const { sessionCookieName } = await import('@/lib/auth/oidc');
const { prisma } = await import('@/lib/prisma');
const { getCurrentUser, signSession } = await import('@/lib/auth/session');
const exchange = vi.mocked(exchangeDingtalkCode);
const fetchUser = vi.mocked(fetchDingtalkUser);
const upsert = vi.mocked(prisma.user.upsert);
const findUnique = vi.mocked(prisma.user.findUnique);

const ORIGIN = 'https://budget.example';
const FLOW = { state: 'st-good', returnTo: '/projects' };
const ACTIVE_USER = { id: 'user-uuid-1', name: '张三', role: 'USER', status: 'active' };

function req(path: string, cookies = ''): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    headers: cookies ? { cookie: cookies, 'sec-fetch-site': 'same-origin' } : {},
  });
}
const flowCookie = (name: string) => `${name}=${encodeURIComponent(JSON.stringify(FLOW))}`;

/** 立即过期的清除头(非空值时不算清除)。 */
function cleared(setCookies: string[], name: string): string | undefined {
  return setCookies.find((c) => c.startsWith(`${name}=;`) || c.startsWith(`${name}=""`));
}

describe('https 部署的认证 cookie', () => {
  it('登录入口下发的流程 cookie 带 __Host- 前缀、Secure、HttpOnly、Path=/,不带 Domain', async () => {
    const res = await dingtalkLogin(req('/api/auth/dingtalk/login?returnTo=/projects'));
    expect(res.status).toBe(307);
    const setCookies = res.headers.getSetCookie();
    const flow = setCookies.find((c) => c.startsWith('__Host-bm_dingtalk_flow='));
    expect(flow).toBeTruthy();
    expect(flow).toMatch(/;\s*Secure/i);
    expect(flow).toMatch(/;\s*HttpOnly/i);
    expect(flow).toMatch(/;\s*Path=\/(;|$)/i);
    expect(flow).not.toMatch(/Domain=/i);
    // 不再下发无前缀的同名 cookie。
    expect(setCookies.some((c) => c.startsWith('bm_dingtalk_flow='))).toBe(false);
  });

  it('兄弟子域投放的无前缀流程 cookie 不被读取(登录 CSRF)', async () => {
    const res = await dingtalkCallback(
      req(
        `/api/auth/dingtalk/callback?code=good&state=${FLOW.state}`,
        flowCookie('bm_dingtalk_flow'),
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(encodeURIComponent('登录流程已过期'));
    expect(exchange).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('本站下发的 __Host- 流程 cookie 可完成登录;会话 cookie 带前缀,流程 cookie 清除头带 Secure', async () => {
    exchange.mockResolvedValueOnce({ accessToken: 'at-1', refreshToken: '', expireIn: 7200 });
    fetchUser.mockResolvedValueOnce({ nick: '张三', unionId: 'union-1', openId: 'o-1' });
    upsert.mockResolvedValueOnce(ACTIVE_USER as never);

    const res = await dingtalkCallback(
      req(
        `/api/auth/dingtalk/callback?code=good&state=${FLOW.state}`,
        flowCookie(dingtalkFlowCookieName()),
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/projects`);

    const setCookies = res.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith('__Host-bm_session='));
    expect(session).toBeTruthy();
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
    expect(session).not.toMatch(/Domain=/i);
    expect(setCookies.some((c) => c.startsWith('bm_session='))).toBe(false);

    // Next 的 cookies.delete() 不带 Secure,浏览器会拒绝;清除头必须自己带上。
    const flow = cleared(setCookies, '__Host-bm_dingtalk_flow');
    expect(flow).toMatch(/;\s*Secure/i);
    expect(flow).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  });

  it('getCurrentUser 只认带前缀的会话 cookie', async () => {
    const token = await signSession(ACTIVE_USER.id);
    // 仅无前缀的旧名/被投放的同名 cookie:不认。
    requestCookies.header = `bm_session=${token}`;
    await expect(getCurrentUser()).resolves.toBeNull();

    // 旧名在前、本站 cookie 在后:取本站下发的那一个。
    requestCookies.header = `bm_session=forged; __Host-bm_session=${token}`;
    findUnique.mockResolvedValueOnce(ACTIVE_USER as never);
    expect((await getCurrentUser())?.id).toBe(ACTIVE_USER.id);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: ACTIVE_USER.id } });
    expect(sessionCookieName()).toBe('__Host-bm_session');
  });

  it('登出清除带前缀的会话/流程 cookie 与无前缀旧名,清除头均带 Secure', async () => {
    const token = await signSession(ACTIVE_USER.id);
    const res = await logout(
      req('/api/auth/logout', `__Host-bm_session=${token}; bm_session=stale`),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login`);

    const setCookies = res.headers.getSetCookie();
    for (const name of [
      '__Host-bm_session',
      'bm_session',
      '__Host-bm_oidc_flow',
      '__Host-bm_dingtalk_flow',
      'bm_oidc_flow',
      'bm_dingtalk_flow',
    ]) {
      const header = cleared(setCookies, name);
      expect(header, name).toBeTruthy();
      expect(header, name).toMatch(/;\s*Secure/i);
      expect(header, name).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    }
    expect(cleared(setCookies, 'bm_auth_mode')).toBeTruthy();
  });
});
