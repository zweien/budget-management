import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * 认证 cookie 命名:cookie 名按对外 URL 协议推导,env 在模块加载时解析一次,
 * 故用 resetModules 分别以 http / https 的 APP_BASE_URL 各导入一遍。
 */
const saved = { APP_BASE_URL: process.env.APP_BASE_URL, MOCK_AUTH: process.env.MOCK_AUTH };
process.env.DATABASE_URL ??= 'postgresql://vitest:vitest@localhost:5432/vitest';
// 钉为 mock 模式:只测命名,不触发 SSO 提供方的成组校验。
process.env.MOCK_AUTH = 'true';
afterAll(() => {
  for (const key of ['APP_BASE_URL', 'MOCK_AUTH'] as const) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function load(baseUrl: string) {
  process.env.APP_BASE_URL = baseUrl;
  vi.resetModules();
  const oidc = await import('@/lib/auth/oidc');
  const dingtalk = await import('@/lib/auth/dingtalk');
  return {
    session: oidc.sessionCookieName(),
    oidcFlow: oidc.oidcFlowCookieName(),
    dingtalkFlow: dingtalk.dingtalkFlowCookieName(),
  };
}

describe('认证 cookie 命名', () => {
  it('http 部署:无前缀(浏览器不接受不带 Secure 的 __Host- cookie)', async () => {
    expect(await load('http://budget.intranet:3000')).toEqual({
      session: 'bm_session',
      oidcFlow: 'bm_oidc_flow',
      dingtalkFlow: 'bm_dingtalk_flow',
    });
  });

  it('https 部署:会话与两种登录流程 cookie 均带 __Host- 前缀', async () => {
    expect(await load('https://budget.example')).toEqual({
      session: '__Host-bm_session',
      oidcFlow: '__Host-bm_oidc_flow',
      dingtalkFlow: '__Host-bm_dingtalk_flow',
    });
  });
});
