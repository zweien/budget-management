import { describe, it, expect } from 'vitest';

// oidc.ts 导入链上的 env.ts 在模块加载时强校验 DATABASE_URL(生产由部署环境注入,
// CI 由 workflow 注入);本地单测自足:先注入占位值再动态导入被测模块(zod 仅校验
// URL 格式,不会建立真实连接),不依赖外部环境。
process.env.DATABASE_URL ??= 'postgresql://vitest:vitest@localhost:5432/vitest';
const { rebuildCallbackUrl, sanitizeReturnTo } = await import('@/lib/auth/oidc');

describe('sanitizeReturnTo(防开放重定向)', () => {
  it('站内绝对路径原样保留', () => {
    expect(sanitizeReturnTo('/projects')).toBe('/projects');
    expect(sanitizeReturnTo('/projects/123/records?subjectId=a&year=2026')).toBe(
      '/projects/123/records?subjectId=a&year=2026',
    );
  });

  it('空值/缺失回落到 /', () => {
    expect(sanitizeReturnTo(null)).toBe('/');
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
  });

  it('拒绝协议相对与绝对 URL(开放重定向)', () => {
    expect(sanitizeReturnTo('//evil.com')).toBe('/');
    expect(sanitizeReturnTo('https://evil.com')).toBe('/');
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/');
  });

  it('拒绝相对路径与控制字符', () => {
    expect(sanitizeReturnTo('projects')).toBe('/');
    expect(sanitizeReturnTo('/projects\u0000.evil')).toBe('/');
  });
});

describe('rebuildCallbackUrl(以对外地址重建回调 URL)', () => {
  const PUBLIC_CALLBACK = 'http://11.1.153.96:3001/api/auth/callback';

  it('origin 换成对外地址,query 完整保留', () => {
    // Next 16 下 req.url 的 origin 是容器内监听地址(standalone HOSTNAME:PORT)
    const containerReqUrl =
      'http://0.0.0.0:3000/api/auth/callback?state=st-1&code=abc&iss=http%3A%2F%2Fidp';
    const rebuilt = rebuildCallbackUrl(containerReqUrl, PUBLIC_CALLBACK);
    expect(rebuilt.origin).toBe('http://11.1.153.96:3001');
    expect(rebuilt.pathname).toBe('/api/auth/callback');
    expect(rebuilt.searchParams.get('state')).toBe('st-1');
    expect(rebuilt.searchParams.get('code')).toBe('abc');
    expect(rebuilt.searchParams.get('iss')).toBe('http://idp');
  });

  it('重建结果与授权阶段登记的 redirect_uri 同构(仅差 query)', () => {
    const rebuilt = rebuildCallbackUrl(
      'http://container-id:3000/api/auth/callback?code=x',
      PUBLIC_CALLBACK,
    );
    // openid-client 以传入 URL 的 origin+pathname 回传 redirect_uri,须与登记值 strict 相等
    expect(`${rebuilt.origin}${rebuilt.pathname}`).toBe(PUBLIC_CALLBACK);
    expect(rebuilt.search).toBe('?code=x');
  });

  it('无 query 的回调 URL 重建后不带 search', () => {
    const rebuilt = rebuildCallbackUrl('http://0.0.0.0:3000/api/auth/callback', PUBLIC_CALLBACK);
    expect(rebuilt.search).toBe('');
  });
});
