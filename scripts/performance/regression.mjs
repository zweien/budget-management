import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { localRuntime, browserOptions, isRecords, recordsReady, delay } from './runtime.mjs';

const runtime = await localRuntime();
const { base, fixture, api } = runtime;
const project = fixture.projects[0];
const url = `${base.origin}/projects/${project.id}/records`;
const only = process.env.PERF_REGRESSION_ONLY;
const result = { capturedAt: new Date().toISOString(), label: process.env.PERF_LABEL, cases: [] };
const browser = await chromium.launch(browserOptions());
const run = async (name, test) => {
  if (only && only !== name) return;
  const context = await runtime.context(browser);
  const page = await context.newPage();
  const start = performance.now();
  try {
    await page.goto(url);
    await recordsReady(page);
    const detail = await test(page);
    result.cases.push({ name, passed: true, ms: performance.now() - start, ...detail });
  } catch (error) {
    result.cases.push({ name, passed: false, error: error.message });
  } finally { await context.close(); }
  console.log(JSON.stringify(result.cases.at(-1)));
};
try {
  await run('pending-bulk', async (page) => {
    await page.getByRole('checkbox', { name: '全选可见记录', exact: true }).check();
    assert.equal(await page.getByRole('button', { name: '批量作废', exact: true }).count(), 1);
    let release;
    const gate = new Promise((done) => { release = done; });
    let observed;
    const intercepted = new Promise((done) => { observed = done; });
    await page.route('**/api/statistics/custom?**', async (route) => {
      if (new URL(route.request().url()).searchParams.has('summary')) {
        observed(); await gate;
      }
      await route.continue();
    });
    try {
      await page.getByRole('button', { name: '筛选摘要', exact: true }).click();
      await page.getByPlaceholder('包含…').fill(`no-match-${randomUUID()}`);
      await page.getByPlaceholder('包含…').press('Enter');
      await intercepted;
      await delay(100);
      const button = page.getByRole('button', { name: '批量作废', exact: true });
      assert.ok((await button.count()) === 0 || await button.isDisabled(), '查询未就绪时仍可提交旧筛选的批量作废');
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  await run('late-write-page', async (page) => {
    let release;
    const gate = new Promise((done) => { release = done; });
    let observed;
    const intercepted = new Promise((done) => { observed = done; });
    await page.route('**/records/*/status', async (route) => {
      observed(); await gate;
      // 控制网络完成顺序，专门验证 UI 闭包；不实际变更合成记录的业务状态。
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"record":{}}' });
    });
    const after = [];
    let released = false;
    page.on('request', (request) => {
      const parsed = new URL(request.url());
      if (released && parsed.pathname === '/api/statistics/custom') after.push(parsed.searchParams.get('page'));
    });
    try {
      await page.locator('main tbody tr').nth(1).getByRole('button', { name: '状态', exact: true }).click();
      await page.getByRole('menuitem').first().click();
      await intercepted;
      const next = page.waitForResponse((response) => isRecords(response) && new URL(response.url()).searchParams.get('page') === '2');
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await next; await recordsReady(page);
      const refreshed = page.waitForResponse(isRecords);
      released = true; release(); await refreshed; await recordsReady(page);
      assert.ok(after.length > 0 && after.every((value) => value === '2'), `写后刷新错误页码: ${after}`);
      return { refreshedPages: after };
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  await run('pagination-filter-export', async (page) => {
    const next = page.waitForResponse((response) => isRecords(response) && new URL(response.url()).searchParams.get('page') === '2');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    const page2 = await (await next).json(); await recordsReady(page);
    assert.equal(page2.records.length, 100);
    const requests = [];
    page.on('request', (request) => {
      const u = new URL(request.url());
      if (u.pathname === '/api/statistics/custom' && u.searchParams.get('summary') === '性能合成业务') requests.push(u.href);
    });
    await page.getByRole('button', { name: '筛选摘要', exact: true }).click();
    const filtered = page.waitForResponse((response) => isRecords(response) && new URL(response.url()).searchParams.get('summary') === '性能合成业务');
    await page.getByPlaceholder('包含…').pressSequentially('性能合成业务', { delay: 15 });
    const payload = await (await filtered).json(); await recordsReady(page);
    await page.keyboard.press('Escape');
    assert.equal(requests.length, 1, '连续输入应仅产生一次完成输入后的列表请求');
    assert.ok(new URL(page.url()).searchParams.has('f'));
    assert.match(await page.locator('main').innerText(), /第 1 \/ /);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出筛选结果', exact: true }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.concat(chunks));
    assert.equal(workbook.worksheets[0].rowCount - 2, payload.total, '导出必须覆盖筛选全集，不能只导出当前100行');
    await page.reload(); await recordsReady(page);
    const state = JSON.parse(Buffer.from(new URL(page.url()).searchParams.get('f'), 'base64url'));
    assert.equal(state.columnFilters.find((f) => f.id === 'summary').value, '性能合成业务');
    return { filteredTotal: payload.total, exportRows: workbook.worksheets[0].rowCount - 2, listRequestsAfterTyping: requests.length - 1 };
  });
  await run('clear-state-includes-void', async (page) => {
    const expected = (await api(`/api/statistics/custom?projectId=${project.id}&includeVoid=1&page=1&pageSize=1`)).json.total;
    const changed = page.waitForResponse((response) => isRecords(response) && !new URL(response.url()).searchParams.has('statuses'));
    await page.getByRole('button', { name: '清除全部', exact: true }).click();
    const payload = await (await changed).json();
    assert.equal(payload.total, expected, '清除状态筛选时漏掉作废记录');
    return { total: payload.total, voidCount: payload.stats.totalCount - payload.stats.validCount };
  });
  await run('saved-facet', async (page) => {
    if (process.env.PERF_ALLOW_WRITES !== '1') throw new Error('此用例修改合成记录，需 PERF_ALLOW_WRITES=1');
    await page.getByRole('button', { name: '修改', exact: true }).first().click();
    const handler = `性能候选-${randomUUID().slice(0, 8)}`;
    await page.getByRole('dialog').getByLabel('经办人', { exact: true }).fill(handler);
    const facets = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/statistics/custom-facets');
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    const data = await (await facets).json();
    assert.ok(data.handlerNames.includes(handler)); await recordsReady(page);
    await page.getByRole('button', { name: '筛选经办人', exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByText(handler, { exact: true }).count(), 1);
  });
} finally { await browser.close(); }
const output = process.env.PERF_OUTPUT ?? '.scratch/performance/regression.json';
await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n');
if (result.cases.some((test) => !test.passed)) process.exitCode = 1;
