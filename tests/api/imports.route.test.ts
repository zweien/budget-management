import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '@prisma/client';

import { env } from '@/lib/env';
import { POST as uploadPost } from '@/app/api/projects/[id]/imports/route';

// mock 鉴权:大小闸门在鉴权之后、任何 DB 访问之前,无需真实用户。
vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/session')>)();
  return {
    ...actual,
    requireUser: async () => ({ id: 'mock-admin', role: UserRole.ADMIN, name: 'admin' }) as never,
  };
});

/**
 * 导入路由容量边界:文件超过 MAX_IMPORT_BYTES → 413(withRoute 错误信封),
 * 不得进入解析阶段(xlsx 全量进内存,超大文件须在闸门处拒绝)。
 */
describe('imports route(容量边界)', () => {
  it('超过 MAX_IMPORT_BYTES 的 .xlsx → 413', async () => {
    const oversized = new File([new Uint8Array(env.MAX_IMPORT_BYTES + 1)], 'big.xlsx');
    const form = new FormData();
    form.set('file', oversized);
    const req = new Request('http://localhost/api/projects/p1/imports', {
      method: 'POST',
      body: form,
    });
    const res = await uploadPost(req as never, {
      params: Promise.resolve({ id: 'p1' }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('大小上限');
    expect(body.requestId).toBeTruthy();
  });

  it('非 .xlsx → 400(顺序:类型检查在大小检查之前)', async () => {
    const small = new File([new Uint8Array(10)], 'a.csv');
    const form = new FormData();
    form.set('file', small);
    const req = new Request('http://localhost/api/projects/p1/imports', {
      method: 'POST',
      body: form,
    });
    const res = await uploadPost(req as never, {
      params: Promise.resolve({ id: 'p1' }),
    });
    expect(res.status).toBe(400);
  });
});
