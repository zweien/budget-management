import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { HTTPError } from '@/lib/auth/session';
import { withRoute } from '@/lib/api/withRoute';

/**
 * withRoute(HTTP 边缘深模块)单元测试:直调返回的函数,不启 HTTP。
 * 覆盖:透传、HTTPError、Prisma 翻译、Zod/Syntax、未知错误不漏栈、请求日志结构。
 */

function makeReq(path = '/api/test'): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

async function call(handler: ReturnType<typeof withRoute>, path = '/api/test'): Promise<Response> {
  return handler(makeReq(path), undefined as never);
}

describe('withRoute(HTTP 边缘)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('成功 → 响应原样透传', async () => {
    const handler = withRoute(async () => NextResponse.json({ ok: true }));
    const res = await call(handler);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('HTTPError → 状态码与消息透传', async () => {
    const handler = withRoute(async () => {
      throw new HTTPError(403, '无权操作');
    });
    const res = await call(handler);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('无权操作');
    expect(body.requestId).toBeTruthy();
  });

  it('HTTPError(5xx) → 堆栈进服务端 error 日志(客户端仍无泄漏)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withRoute(async () => {
      throw new HTTPError(500, '导出失败');
    });
    const res = await call(handler);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('导出失败');
    const log = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(log.level).toBe('error');
    expect(typeof log.stack).toBe('string');
    expect(log.stack.length).toBeGreaterThan(0);
  });

  it('Prisma P2002 → 409 唯一性冲突(含字段)', async () => {
    const handler = withRoute(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['project_id', 'docNo'] },
      });
    });
    const res = await call(handler);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('唯一性冲突');
  });

  it('Prisma P2025 → 404、P2028 → 503', async () => {
    const p2025 = withRoute(async () => {
      throw new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      });
    });
    expect((await call(p2025)).status).toBe(404);
    const p2028 = withRoute(async () => {
      throw new Prisma.PrismaClientKnownRequestError('timeout', {
        code: 'P2028',
        clientVersion: 'test',
      });
    });
    expect((await call(p2028)).status).toBe(503);
  });

  it('ZodError → 422 首个 issue;SyntaxError → 400', async () => {
    const zodHandler = withRoute(async () => {
      z.string().parse(123);
      return NextResponse.json({});
    });
    const zodRes = await call(zodHandler);
    expect(zodRes.status).toBe(422);
    expect((await zodRes.json()).error).toBeTruthy();

    const synHandler = withRoute(async () => {
      throw new SyntaxError('Unexpected token');
    });
    const synRes = await call(synHandler);
    expect(synRes.status).toBe(400);
    expect((await synRes.json()).error).toContain('JSON');
  });

  it('未知错误 → 500,客户端只见通用文案(不泄漏内部信息)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withRoute(async () => {
      throw new Error('internal db host is db-01.prod');
    });
    const res = await call(handler);
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('db-01.prod');
    // 5xx 进 error 级日志且带内部堆栈(仅服务端可见)
    expect(errSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(log.level).toBe('error');
    expect(log.stack).toContain('internal db host');
  });

  it('请求日志:一行结构化 JSON,含 requestId/method/path/status/耗时', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = withRoute(async () => NextResponse.json({ ok: true }));
    await call(handler, '/api/health');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(log.msg).toBe('http_request');
    expect(log.level).toBe('info');
    expect(log.method).toBe('GET');
    expect(log.path).toBe('/api/health');
    expect(log.status).toBe(200);
    expect(log.requestId).toBeTruthy();
    expect(typeof log.durationMs).toBe('number');
  });
});
