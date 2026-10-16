import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { withRoute } from '@/lib/api/withRoute';
import { HTTPError } from '@/lib/auth/session';
import {
  beginInteractiveRequest,
  yieldToInteractiveRequests,
} from '@/server/observability/interactive-requests';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterAll(() => {
  vi.useRealTimers();
});

describe('日常请求优先', () => {
  it('日常请求完成并经过安静窗口后，大文件才继续读取；重复释放不减多次', async () => {
    const finish = beginInteractiveRequest('/api/projects/p/records', 'POST');
    let resumed = false;
    const waiting = yieldToInteractiveRequests().then(() => {
      resumed = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(resumed).toBe(false);
      finish();
      finish();
      await vi.advanceTimersByTimeAsync(20);
      expect(resumed).toBe(false);
      const next = beginInteractiveRequest('/api/statistics/custom', 'GET');
      next();
      await vi.advanceTimersByTimeAsync(20);
      expect(resumed).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await waiting;
      expect(resumed).toBe(true);
    } finally {
      finish();
    }
  });

  it('重任务不等待自身，短安静窗口后继续', async () => {
    const finish = beginInteractiveRequest('/api/projects/p/attachments/export', 'GET');
    const waiting = yieldToInteractiveRequests();
    await vi.advanceTimersByTimeAsync(40);
    await waiting;
    finish();
  });

  it('持续交互最多让行1秒，防止打包长期饿死', async () => {
    const finish = beginInteractiveRequest('/api/statistics/custom', 'GET');
    const waiting = yieldToInteractiveRequests();
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await waiting;
    } finally {
      finish();
    }
  });

  it('HTTP处理失败仍释放日常请求名额', async () => {
    const handler = withRoute(async () => {
      throw new HTTPError(403, '拒绝');
    });
    const response = await handler(
      new NextRequest('http://localhost/api/projects/p/records'),
      undefined,
    );
    expect(response.status).toBe(403);
    const waiting = yieldToInteractiveRequests();
    await vi.advanceTimersByTimeAsync(40);
    await waiting;
  });
});
