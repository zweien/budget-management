import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// 本仓库首个 auth 路由测试:SSO 模式 + 钉钉提供方下走通回调主链路。
// 环境自足(同 dingtalk.test.ts 说明):先种 env 再动态导入被测模块;
// singleFork 共享 process.env,afterAll 恢复防泄漏。
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
// APP_BASE_URL 显式钉住(断言 localhost:3000 的 302 目标):
// 先跑的测试可能经 Prisma 注入 .env 的值,??=/缺省兜底会随 .env 内容漂移。
process.env.APP_BASE_URL = 'http://localhost:3000';
afterAll(() => {
  for (const key of MUTATED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// DB 访问整体 mock:回调只做 upsert,不触真实库。
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { upsert: vi.fn() } },
}));

// 仅替换网络出口(token 交换/取用户信息),常量与纯函数保留真实实现。
vi.mock('@/lib/auth/dingtalk', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/dingtalk')>)();
  return {
    ...actual,
    exchangeDingtalkCode: vi.fn(),
    fetchDingtalkUser: vi.fn(),
  };
});

const { GET } = await import('@/app/api/auth/dingtalk/callback/route');
const { exchangeDingtalkCode, fetchDingtalkUser, DINGTALK_FLOW_COOKIE, SESSION_COOKIE } =
  await import('@/lib/auth/dingtalk');
const { prisma } = await import('@/lib/prisma');
const { verifySession } = await import('@/lib/auth/session');
const upsert = vi.mocked(prisma.user.upsert);
const exchange = vi.mocked(exchangeDingtalkCode);
const fetchUser = vi.mocked(fetchDingtalkUser);

const FLOW = { state: 'st-good', returnTo: '/projects' };

function makeReq(query: string, flow?: object): NextRequest {
  const headers: Record<string, string> = {};
  if (flow)
    headers['cookie'] = `${DINGTALK_FLOW_COOKIE}=${encodeURIComponent(JSON.stringify(flow))}`;
  return new NextRequest(`http://localhost:3000/api/auth/dingtalk/callback?${query}`, { headers });
}

describe('钉钉 callback 路由', () => {
  it('流程 cookie 缺失 → 回登录页报流程过期,不触网络与 DB', async () => {
    const res = await GET(makeReq('code=c&state=s'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?error=');
    expect(exchange).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('state 不匹配(CSRF)→ 拒绝并清流程 cookie', async () => {
    const res = await GET(makeReq('code=c&state=evil', FLOW));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(encodeURIComponent('登录状态校验失败'));
    expect(upsert).not.toHaveBeenCalled();
  });

  it('授权码缺失 → 回登录页报错', async () => {
    const res = await GET(makeReq(`state=${FLOW.state}`, FLOW));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(encodeURIComponent('未返回授权码'));
  });

  it('token 交换失败 → 兜底错误,不建档', async () => {
    exchange.mockRejectedValueOnce(new Error('钉钉 userAccessToken 交换失败: HTTP 400'));
    const res = await GET(makeReq(`code=bad&state=${FLOW.state}`, FLOW));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(encodeURIComponent('登录失败'));
    expect(upsert).not.toHaveBeenCalled();
  });

  it('成功:JIT 建档(dingtalk:<unionId>)→ 会话 cookie → 302 回 returnTo', async () => {
    exchange.mockResolvedValueOnce({ accessToken: 'at-1', refreshToken: 'rt-1', expireIn: 7200 });
    fetchUser.mockResolvedValueOnce({ nick: '张三', unionId: 'union-1', openId: 'o-1' });
    upsert.mockResolvedValueOnce({
      id: 'user-uuid-1',
      name: '张三',
      role: 'USER',
      status: 'active',
    } as never);

    const res = await GET(makeReq(`code=good&state=${FLOW.state}`, FLOW));
    expect(res.status).toBe(307);
    // returnTo 站内跳转,非开放重定向
    expect(res.headers.get('location')).toBe('http://localhost:3000/projects');
    // upsert 以命名空间化 unionId 为键,登录不回写显示名
    expect(upsert).toHaveBeenCalledWith({
      where: { authSubject: 'dingtalk:union-1' },
      update: {},
      create: expect.objectContaining({ name: '张三', role: 'USER' }),
    });
    // 会话 cookie 可验签且 sub=本地用户 id;流程 cookie 被置空清理
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookie).toBeTruthy();
    const session = await verifySession(sessionCookie!.slice(SESSION_COOKIE.length + 1));
    expect(session?.userId).toBe('user-uuid-1');
    expect(cookies.some((c) => c.startsWith('bm_auth_mode=sso'))).toBe(true);
    expect(cookies).toContain(`${DINGTALK_FLOW_COOKIE}=`);
  });

  it('停用账号 → 拒绝登录', async () => {
    exchange.mockResolvedValueOnce({ accessToken: 'at-2', refreshToken: 'rt-2', expireIn: 7200 });
    fetchUser.mockResolvedValueOnce({ nick: '李四', unionId: 'union-2', openId: 'o-2' });
    upsert.mockResolvedValueOnce({
      id: 'user-uuid-2',
      name: '李四',
      role: 'USER',
      status: 'disabled',
    } as never);

    const res = await GET(makeReq(`code=good&state=${FLOW.state}`, FLOW));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(encodeURIComponent('账号已停用'));
    expect(res.headers.getSetCookie().some((c) => c.startsWith('bm_session='))).toBe(false);
  });
});
