import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import {
  localRuntime,
  browserOptions,
  recordsReady,
  isRecords,
  paint,
  summarize,
} from './runtime.mjs';

// 弱网络与大预览是探索项，不混入主验收分位数。不确认导入或写业务记录。
const runtime = await localRuntime();
const { base, fixture, api } = runtime;
const result = {
  capturedAt: new Date().toISOString(),
  label: process.env.PERF_LABEL,
  network: { latency: 80, downloadThroughput: 625000, uploadThroughput: 125000 },
  weakNetwork: [],
  preview: null,
  errors: [],
};
const browser = await chromium.launch(browserOptions());
result.chromium = browser.version();
try {
  for (const name of ['project-records', 'ledger', 'filter']) {
    const values = [];
    for (let sample = 0; sample < 3; sample++) {
      const context = await runtime.context(browser);
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', (res) => {
          if (new URL(res.url()).pathname.startsWith('/api/') && res.status() >= 400)
            errors.push(`API HTTP ${res.status()}`);
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, ...result.network });
        const path = `/projects/${fixture.projects[0].id}/${name === 'ledger' ? 'ledger' : 'records'}`;
        let start = performance.now();
        await page.goto(`${base.origin}${path}`, { waitUntil: 'domcontentloaded' });
        if (name === 'ledger') {
          await page.waitForFunction(
            () =>
              document.querySelectorAll('main tbody tr').length > 1 &&
              !document.querySelector('main [data-slot="skeleton"]'),
          );
          await paint(page);
        } else await recordsReady(page);
        if (name === 'filter') {
          await page.getByRole('button', { name: '筛选摘要', exact: true }).click();
          const refreshed = page.waitForResponse(
            (res) => isRecords(res) && new URL(res.url()).searchParams.has('summary'),
          );
          start = performance.now();
          await page.getByPlaceholder('包含…').fill('性能合成业务');
          await refreshed;
          await recordsReady(page);
        }
        assert.deepEqual(errors, []);
        values.push(performance.now() - start);
      } finally {
        await context.close();
      }
    }
    result.weakNetwork.push({ name, ms: summarize(values) });
  }
  let pending;
  for (const project of fixture.projects) {
    const { batches } = (await api(`/api/projects/${project.id}/imports`)).json;
    const batch = batches.find(
      (b) => b.status === 'pending' && b.fileName.startsWith('performance-interference-'),
    );
    if (batch) {
      pending = { project, batch };
      break;
    }
  }
  assert.ok(pending, '先运行分类干扰，生成2000行暂存合成批次');
  const context = await runtime.context(browser);
  try {
    const page = await context.newPage();
    const start = performance.now();
    await page.goto(
      `${base.origin}/projects/${pending.project.id}/imports?batch=${pending.batch.batchId}`,
    );
    await page.getByRole('button', { name: '确认导入(2000 行)', exact: true }).waitFor();
    await paint(page);
    result.preview = {
      ms: performance.now() - start,
      ...(await page.evaluate(() => ({
        domNodes: document.querySelectorAll('*').length,
        tableRows: document.querySelectorAll('main tbody tr').length,
      }))),
    };
    assert.equal(result.preview.tableRows, 100);
    const first = page.getByRole('checkbox').first();
    const label = await first.getAttribute('aria-label');
    await first.uncheck();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: label, exact: true }).count(), 0);
    await page.getByRole('button', { name: '确认导入(1999 行)', exact: true }).waitFor();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: label, exact: true }).isChecked(), false);
    result.preview.selectionAcrossPages = true;
  } finally {
    await context.close();
  }
} catch (error) {
  result.errors.push(error.message);
} finally {
  await browser.close();
}
const output = process.env.PERF_OUTPUT ?? '.scratch/performance/explore.json';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
if (
  result.errors.length ||
  result.weakNetwork.length !== 3 ||
  !result.preview?.selectionAcrossPages
)
  process.exitCode = 1;
