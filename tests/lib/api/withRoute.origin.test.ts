import { describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import { crossOriginWriteReason, withRoute } from '@/lib/api/withRoute';

/**
 * 跨源写请求拦截(withRoute 边缘):SSO 模式下以 APP_BASE_URL 的源为唯一可信源。
 * env 在模块加载时解析,这里整体替换为 SSO 模式 + https 对外地址。
 */
vi.mock('@/lib/env', async (importOriginal) => ({
  env: {
    ...(await importOriginal<typeof import('@/lib/env')>()).env,
    MOCK_AUTH: false,
    APP_BASE_URL: 'https://budget.example',
  },
}));

const TRUSTED = 'https://budget.example';

/** 容器内监听地址:Next 16 下 req.url 的 origin 是它,不是浏览器所见的外部地址。 */
function req(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://127.0.0.1:3000/api/test', { method, headers });
}

describe('crossOriginWriteReason', () => {
  it('安全方法不做判定', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        crossOriginWriteReason(req(method, { origin: 'https://evil.example' }), TRUSTED),
      ).toBeNull();
    }
  });

  it('同源 Origin 放行(scheme/主机大小写与末尾斜杠归一后比较)', () => {
    expect(crossOriginWriteReason(req('POST', { origin: TRUSTED }), TRUSTED)).toBeNull();
    expect(
      crossOriginWriteReason(req('PATCH', { origin: 'HTTPS://BUDGET.example/' }), TRUSTED),
    ).toBeNull();
  });

  it('兄弟子域(同站不同源)、其他站点、端口不同、"null"、非法值 → 拒绝', () => {
    for (const origin of [
      'https://salary.example',
      'https://evil.example',
      'http://budget.example',
      'https://budget.example:8443',
      'null',
      'not a url',
    ]) {
      expect(crossOriginWriteReason(req('DELETE', { origin }), TRUSTED)).toBe('跨站请求被拒绝');
    }
  });

  it('Sec-Fetch-Site 为 same-site / cross-site 即拒绝,即便 Origin 伪造成同源', () => {
    for (const fetchSite of ['same-site', 'cross-site']) {
      expect(
        crossOriginWriteReason(
          req('PUT', { origin: TRUSTED, 'sec-fetch-site': fetchSite }),
          TRUSTED,
        ),
      ).toBe('跨站请求被拒绝');
    }
  });

  it('非浏览器客户端(无 Origin、无 Sec-Fetch-Site)放行', () => {
    expect(crossOriginWriteReason(req('POST'), TRUSTED)).toBeNull();
    expect(
      crossOriginWriteReason(req('POST', { authorization: 'Bearer bma_x' }), TRUSTED),
    ).toBeNull();
  });
});

describe('withRoute 的跨源写请求拦截(SSO 模式)', () => {
  it('兄弟子域来源的写请求 403,handler 不被调用(请求体不会被缓冲)', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const res = await withRoute(handler)(
      req('POST', { origin: 'https://salary.example' }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('跨站请求被拒绝');
    expect(handler).not.toHaveBeenCalled();
  });

  it('同源写请求照常进入 handler', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const res = await withRoute(handler)(req('POST', { origin: TRUSTED }), undefined as never);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('带 Origin 的读请求不受影响', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const res = await withRoute(handler)(
      req('GET', { origin: 'https://evil.example' }),
      undefined as never,
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
