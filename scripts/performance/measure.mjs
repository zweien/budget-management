import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { chromium } from 'playwright';

const base = new URL(process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3110');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || Number(base.port) < 3100) {
  throw new Error('基准仅允许本机 3100 以上的专用端口');
}
const secret = process.env.PERF_AUTH_SECRET;
if (!secret || secret.length < 32) throw new Error('必须提供专用 PERF_AUTH_SECRET（至少32字符）');
const fixture = JSON.parse(
  await readFile(process.env.PERF_FIXTURE ?? '.scratch/performance/fixture.json'),
);
const samples = Number(process.env.PERF_SAMPLES ?? 20);
const browserSamples = Number(process.env.PERF_BROWSER_SAMPLES ?? 5);
const output = resolve(process.env.PERF_OUTPUT ?? '.scratch/performance/baseline.json');
const only = new Set((process.env.PERF_ONLY ?? '').split(',').filter(Boolean));
const selected = (name) => only.size === 0 || only.has(name);
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  !Number.isInteger(browserSamples) ||
  browserSamples < 0
) {
  throw new Error('PERF_SAMPLES 必须为正整数，PERF_BROWSER_SAMPLES 必须为非负整数');
}
const token = await new SignJWT()
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(fixture.users[0].id)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret));
const cookie = `bm_session=${token}; bm_auth_mode=sso`;
const project = fixture.projects[0];
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    n: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
};
const result = {
  capturedAt: new Date().toISOString(),
  label: process.env.PERF_LABEL ?? 'baseline',
  node: process.version,
  projects: fixture.projects.length,
  rowsPerProject: fixture.rowsPerProject,
  api: [],
  browser: [],
  errors: [],
};
await mkdir(dirname(output), { recursive: true });
const flush = () => writeFile(output, JSON.stringify(result, null, 2) + '\n');
const get = async (path) => {
  const start = performance.now();
  const response = await fetch(new URL(path, base), { headers: { cookie }, redirect: 'manual' });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path.split('?')[0]} HTTP ${response.status}`);
  return { durationMs: performance.now() - start, bytes: Buffer.byteLength(body), body };
};
// 防止误对现有开发/业务服务执行基准：身份、项目集合必须与专用夹具完全对应。
const preflight = JSON.parse((await get('/api/projects')).body);
if (preflight.length !== fixture.projects.length || !preflight.some((p) => p.id === project.id)) {
  throw new Error('应用数据与专用性能夹具不一致，拒绝测量');
}
result.rowsAtStart = JSON.parse(
  (await get('/api/statistics/custom?includeVoid=1&page=1&pageSize=1')).body,
).total;

const routes = [
  ['projects', '/api/projects'],
  ['project', `/api/projects/${project.id}`],
  ['ledger', `/api/projects/${project.id}/ledger?year=2026`],
  ['ledger-total', `/api/projects/${project.id}/ledger-total`],
  ['project-records-legacy', `/api/projects/${project.id}/records?includeVoid=1`],
  ['records-page', '/api/statistics/custom?page=1&pageSize=100'],
  ['records-project-page', `/api/statistics/custom?projectId=${project.id}&page=1&pageSize=100`],
  ['cross-project', '/api/statistics/cross-project?year=2026'],
  ['risk', '/api/statistics/risk-summary?year=2026'],
  ['balance', '/api/statistics/balance?year=2026'],
  ['attachment-list', `/api/projects/${project.id}/records/${project.recordId}/attachments`],
];
const browserRoutes = [
  ['dashboard', '/'],
  ['projects', '/projects'],
  ['records', '/records'],
  ['project', `/projects/${project.id}`],
  ['ledger', `/projects/${project.id}/ledger`],
  ['project-records', `/projects/${project.id}/records`],
  ['statistics', '/statistics'],
  ['imports', `/projects/${project.id}/imports`],
];
const available = new Set([...routes, ...browserRoutes].map(([name]) => name));
for (const name of only) if (!available.has(name)) throw new Error(`未知测量场景: ${name}`);
if (
  !routes.some(([name]) => selected(name)) &&
  !(browserSamples > 0 && browserRoutes.some(([name]) => selected(name)))
)
  throw new Error('所选场景没有可执行样本');
for (const [name, route] of routes.filter(([name]) => selected(name))) {
  await get(route); // 预热另计，正式样本不含模块首次加载。
  const values = [];
  let response;
  for (let i = 0; i < samples; i++) {
    response = await get(route);
    values.push(response.durationMs);
  }
  result.api.push({
    name,
    ms: summary(values),
    bytes: response.bytes,
    sha256: createHash('sha256').update(response.body).digest('hex'),
  });
  await flush();
  console.log(JSON.stringify(result.api.at(-1)));
}

if (browserSamples > 0) {
  const browser = await chromium.launch({
    ...(process.env.PERF_CHROMIUM_PATH ? { executablePath: process.env.PERF_CHROMIUM_PATH } : {}),
    headless: true,
  });
  result.chromium = browser.version();
  try {
    for (const [name, path] of browserRoutes.filter(([name]) => selected(name))) {
      const values = [];
      const details = [];
      for (let i = 0; i < browserSamples; i++) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          timezoneId: 'Asia/Shanghai',
        });
        await context.addCookies([
          { name: 'bm_session', value: token, url: base.origin, httpOnly: true, sameSite: 'Lax' },
          { name: 'bm_auth_mode', value: 'sso', url: base.origin, sameSite: 'Lax' },
        ]);
        await context.addInitScript(() => {
          window.__budgetPerfLongTasks = [];
          new PerformanceObserver((list) => {
            window.__budgetPerfLongTasks.push(...list.getEntries().map((e) => e.duration));
          }).observe({ type: 'longtask', buffered: true });
        });
        const page = await context.newPage();
        if (process.env.PERF_FAULT_PATH) {
          await page.route(`**${process.env.PERF_FAULT_PATH}*`, (route) =>
            route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{"error":"performance fault injection"}',
            }),
          );
        }
        const markFailure = () => {
          void page
            .evaluate(() => {
              window.__budgetPerfFailed = true;
            })
            .catch(() => {});
        };
        const requests = [];
        const sampleErrors = [];
        page.on('request', (req) => {
          const url = new URL(req.url());
          if (url.pathname.startsWith('/api/'))
            requests.push(url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id'));
        });
        page.on('pageerror', (error) => {
          sampleErrors.push(error.message);
          markFailure();
        });
        page.on('response', (response) => {
          const url = new URL(response.url());
          if (url.pathname.startsWith('/api/') && response.status() >= 400) {
            sampleErrors.push(
              `${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id')} HTTP ${response.status()}`,
            );
            markFailure();
          }
        });
        const start = performance.now();
        try {
          await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(
            ({ minimumRows }) => {
              if (window.__budgetPerfFailed) return true;
              const main = document.querySelector('main');
              return (
                main &&
                !main.querySelector('[aria-busy="true"]') &&
                main.textContent.trim().length > 0 &&
                !main.querySelector('[data-slot="skeleton"]') &&
                !main.textContent.includes('加载中') &&
                !main.textContent.includes('无法访问该项目') &&
                !main.textContent.includes('加载失败') &&
                main.querySelectorAll('tbody tr').length >= minimumRows
              );
            },
            {
              minimumRows: ['records', 'project-records'].includes(name)
                ? 2
                : ['projects', 'ledger', 'statistics'].includes(name)
                  ? 1
                  : 0,
            },
            { timeout: 60_000 },
          );
          await page.evaluate(
            () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
          );
          if (sampleErrors.length) throw new Error(sampleErrors.join('; '));
          values.push(performance.now() - start);
          const metrics = await page.evaluate(() => ({
            domNodes: document.querySelectorAll('*').length,
            tableRows: document.querySelectorAll('main tbody tr').length,
            longTaskMs: window.__budgetPerfLongTasks.reduce((sum, n) => sum + n, 0),
            resourceBytes: performance
              .getEntriesByType('resource')
              .reduce((sum, e) => sum + e.transferSize, 0),
          }));
          details.push({ ...metrics, requests });
        } catch (error) {
          result.errors.push({ name, error: error.message });
        } finally {
          await context.close();
        }
      }
      result.browser.push({
        name,
        navigation: 'fresh-context full navigation; warm server',
        ms: summary(values),
        details,
      });
      await flush();
      console.log(JSON.stringify({ name, ms: summary(values), last: details.at(-1) }));
    }
  } finally {
    await browser.close();
  }
}
await flush();
console.log(JSON.stringify({ output, errors: result.errors.length }));
if (result.errors.length > 0) process.exitCode = 1;
