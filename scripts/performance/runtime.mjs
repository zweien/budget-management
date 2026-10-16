import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { SignJWT } from 'jose';
import assert from 'node:assert/strict';

export const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export const paint = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
export const summarize = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (fraction) => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null;
  return { n: ordered.length, p50: at(0.5), p95: at(0.95), max: ordered.at(-1) ?? null };
};

/** 交互/写入基准只允许显式专用端口、正常签名会话和完全相符的合成项目集合。 */
export async function localRuntime() {
  const base = new URL(process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3111');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
    Number(base.port) < 3100 ||
    base.protocol !== 'http:'
  ) {
    throw new Error('仅允许本机 3100 以上的专用 HTTP 端口');
  }
  const secret = process.env.PERF_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('缺少专用 PERF_AUTH_SECRET');
  const fixture = JSON.parse(
    await readFile(process.env.PERF_FIXTURE ?? '.scratch/performance/fixture.json'),
  );
  const tokens = await Promise.all(
    fixture.users.map((user) =>
      new SignJWT()
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret)),
    ),
  );
  const api = async (path, options = {}, user = 0) => {
    const start = performance.now();
    const response = await fetch(new URL(path, base), {
      redirect: 'manual',
      ...options,
      headers: { cookie: `bm_session=${tokens[user]}; bm_auth_mode=sso`, ...options.headers },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok)
      throw new Error(
        `${path.split('?')[0]} HTTP ${response.status}: ${buffer.toString('utf8').slice(0, 200)}`,
      );
    return {
      ms: performance.now() - start,
      bytes: buffer.length,
      buffer,
      json: (response.headers.get('content-type') ?? '').includes('json')
        ? JSON.parse(buffer)
        : undefined,
      requestId: response.headers.get('x-request-id'),
      serverTiming: response.headers.get('server-timing'),
    };
  };
  const projects = (await api('/api/projects')).json;
  const actual = projects.map((project) => project.id).sort();
  const expected = fixture.projects.map((project) => project.id).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('服务与专用合成夹具不匹配');
  const context = async (browser, user = 0) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: 'Asia/Shanghai',
    });
    await ctx.addCookies([
      {
        name: 'bm_session',
        value: tokens[user],
        url: base.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
      { name: 'bm_auth_mode', value: 'sso', url: base.origin, sameSite: 'Lax' },
    ]);
    return ctx;
  };
  return { base, fixture, api, context };
}

export const browserOptions = () => ({
  headless: true,
  ...(process.env.PERF_CHROMIUM_PATH ? { executablePath: process.env.PERF_CHROMIUM_PATH } : {}),
});
export const isRecords = (response) =>
  new URL(response.url()).pathname === '/api/statistics/custom';
export async function recordsReady(page) {
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main');
      return (
        main &&
        !main.querySelector('[aria-busy="true"]') &&
        !main.querySelector('[data-slot="skeleton"]') &&
        main.querySelectorAll('tbody tr').length > 1
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  await paint(page);
}

/** 保存计时在浏览器内结束，排除驱动轮询延迟；必须先确认本次刷新响应。 */
export async function armRecordWrite(page, summary = null) {
  await page.evaluate((summary) => {
    window.__interactionStart = null;
    window.__interactionReady = null;
    window.__interactionRefreshComplete = false;
    window.__expectedRecordTotal = null;
    const begin = (event) => {
      if (event.target.closest('button')?.textContent.trim() !== '保存') return;
      document.removeEventListener('click', begin, true);
      window.__interactionStart = performance.now();
      const ready = () => {
        const main = document.querySelector('main');
        return (
          window.__interactionRefreshComplete &&
          main &&
          main.textContent.includes(`共 ${window.__expectedRecordTotal} 条`) &&
          !document.querySelector('[data-slot="dialog-content"]') &&
          !main.querySelector('[aria-busy="true"], [data-slot="skeleton"]') &&
          main.querySelectorAll('tbody tr').length > 1 &&
          (summary === null || main.textContent.includes(summary))
        );
      };
      const observe = () => {
        if (ready())
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (ready()) window.__interactionReady = performance.now();
              else observe();
            }),
          );
        else requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    };
    document.addEventListener('click', begin, true);
  }, summary);
}

export async function acknowledgeRecordRefresh(page, response) {
  assert.ok(response.ok());
  const data = await response.json();
  assert.ok(Array.isArray(data.records) && data.records.length > 1);
  assert.equal(typeof data.total, 'number');
  await page.evaluate((total) => {
    window.__expectedRecordTotal = total;
    window.__interactionRefreshComplete = true;
  }, data.total);
}

export async function recordWriteTiming(page) {
  await page.waitForFunction(() => window.__interactionReady !== null, undefined, {
    timeout: 15_000,
  });
  const timing = await page.evaluate(() => ({
    start: window.__interactionStart,
    end: window.__interactionReady,
    observed: performance.now(),
    origin: performance.timeOrigin,
  }));
  assert.ok(
    typeof timing.start === 'number' && typeof timing.end === 'number' && timing.end > timing.start,
  );
  return {
    start: timing.origin + timing.start - performance.timeOrigin,
    end: timing.origin + timing.end - performance.timeOrigin,
    ms: timing.end - timing.start,
    observedMs: timing.observed - timing.start,
  };
}
