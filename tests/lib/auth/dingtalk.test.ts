import { afterAll, describe, expect, it, vi } from 'vitest';

// dingtalk.ts 导入链上的 env.ts 在模块加载时强校验(同 oidc.test.ts 说明):
// 先注入占位值与钉钉凭证再动态导入被测模块,单测自足、不依赖外部环境。
// singleFork 下 process.env 为全进程共享,afterAll 恢复原值防泄漏到其他测试文件。
const MUTATED_KEYS = ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'] as const;
const saved = Object.fromEntries(MUTATED_KEYS.map((key) => [key, process.env[key]]));
process.env.DATABASE_URL ??= 'postgresql://vitest:vitest@localhost:5432/vitest';
process.env.DINGTALK_CLIENT_ID = 'ding-unit-key';
process.env.DINGTALK_CLIENT_SECRET = 'ding-unit-secret';
afterAll(() => {
  for (const key of MUTATED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const {
  buildDingtalkAuthorizeUrl,
  dingtalkEnabled,
  dingtalkRedirectUri,
  dingtalkSubject,
  randomDingtalkState,
} = await import('@/lib/auth/dingtalk');

describe('buildDingtalkAuthorizeUrl(授权 URL 构造)', () => {
  it('端点与参数完整,redirect_uri 为编码后的完整回调地址', () => {
    const url = buildDingtalkAuthorizeUrl('st-123');
    expect(url.origin + url.pathname).toBe('https://login.dingtalk.com/oauth2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(dingtalkRedirectUri());
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('ding-unit-key');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('state')).toBe('st-123');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('redirect_uri 中的 :// 被整体编码(钉钉按原串回传)', () => {
    const url = buildDingtalkAuthorizeUrl('s');
    expect(url.search).toContain(
      encodeURIComponent('http://localhost:3000/api/auth/dingtalk/callback'),
    );
  });
});

describe('dingtalkRedirectUri(回调地址)', () => {
  it('挂在 APP_BASE_URL 下的 /api/auth/dingtalk/callback', () => {
    expect(dingtalkRedirectUri()).toBe('http://localhost:3000/api/auth/dingtalk/callback');
  });
});

describe('dingtalkSubject(身份命名空间)', () => {
  it('unionId 加 dingtalk: 前缀,与 Authentik sub 共用唯一列', () => {
    expect(dingtalkSubject('union-abc')).toBe('dingtalk:union-abc');
  });
});

describe('randomDingtalkState(防 CSRF)', () => {
  it('url-safe 且不可预测(多次调用不重复)', () => {
    const a = randomDingtalkState();
    const b = randomDingtalkState();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe('dingtalkEnabled(凭证门控)', () => {
  it('凭证成对时启用', () => {
    expect(dingtalkEnabled()).toBe(true);
  });

  it('缺任一凭证即停用(重新加载模块)', async () => {
    const savedSecret = process.env.DINGTALK_CLIENT_SECRET;
    delete process.env.DINGTALK_CLIENT_SECRET;
    try {
      vi.resetModules();
      const fresh = await import('@/lib/auth/dingtalk');
      expect(fresh.dingtalkEnabled()).toBe(false);
    } finally {
      process.env.DINGTALK_CLIENT_SECRET = savedSecret;
      vi.resetModules();
    }
  });
});
