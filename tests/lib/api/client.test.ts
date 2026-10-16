import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch 并发只读请求', () => {
  it('写入完成后的刷新不会合并到写入前仍在进行的读取', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { cookie: 'bm_auth_mode=sso' });
    let finishOld!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ saved: true }))
      .mockResolvedValueOnce(Response.json({ records: ['new'] }));
    vi.stubGlobal('fetch', fetchMock);
    const old = apiFetch('/api/records');
    await Promise.resolve();
    await apiFetch('/api/records', { method: 'POST', body: '{}' });
    const refreshed = apiFetch('/api/records');
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await refreshed).toEqual({ records: ['new'] });
    finishOld(Response.json({ records: [] }));
    await old;
  });
  it('请求失败后允许重试，不保留失败结果', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { cookie: 'bm_auth_mode=sso' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: '暂时不可用' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: 'retry' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/api/me')).rejects.toMatchObject({ status: 503 });
    expect(await apiFetch('/api/me')).toEqual({ id: 'retry' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('同一浏览器并发读取当前用户只发一个 HTTP 请求，完成后仍重新校验', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { cookie: 'bm_auth_mode=sso' });
    let finish!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ id: 'me' }));
    vi.stubGlobal('fetch', fetchMock);
    const first = apiFetch('/api/me');
    const second = apiFetch('/api/me');
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(Response.json({ id: 'me' }));
    expect(await first).toEqual({ id: 'me' });
    expect(await second).toEqual({ id: 'me' });
    await apiFetch('/api/me');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
