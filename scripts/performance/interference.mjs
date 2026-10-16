import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright';
import {
  localRuntime,
  browserOptions,
  recordsReady,
  isRecords,
  paint,
  delay,
  summarize,
  armRecordWrite,
  acknowledgeRecordRefresh,
} from './runtime.mjs';

if (process.env.PERF_ALLOW_WRITES !== '1') throw new Error('需要 PERF_ALLOW_WRITES=1，仅写合成库');
const runtime = await localRuntime();
const { fixture, base, api } = runtime;
assert.ok(fixture.users.length >= 10 && fixture.projects.length >= 10);
const kinds = (process.env.PERF_KINDS ?? 'idle,parse,import,export,zip').split(',');
assert.ok(
  kinds.length &&
    new Set(kinds).size === kinds.length &&
    kinds.every((kind) => ['idle', 'parse', 'import', 'export', 'zip'].includes(kind)),
);
const exportConcurrency = Number(process.env.PERF_EXPORT_CONCURRENCY ?? 1);
assert.ok(Number.isInteger(exportConcurrency) && exportConcurrency >= 1 && exportConcurrency <= 3);
const rounds = Number(process.env.PERF_ROUNDS ?? 2);
assert.ok(Number.isInteger(rounds) && rounds >= 2 && rounds <= 10);
const expectedSamples = 10 * rounds;
const actionsToRun = (process.env.PERF_ACTIONS ?? 'switch,filter,create,edit').split(',');
assert.ok(
  actionsToRun.length &&
    new Set(actionsToRun).size === actionsToRun.length &&
    actionsToRun.every((action) => ['switch', 'filter', 'create', 'edit'].includes(action)),
);
const pageSize = process.env.PERF_PAGE_SIZE ? Number(process.env.PERF_PAGE_SIZE) : null;
assert.ok(pageSize === null || [50, 100, 200].includes(pageSize));
const result = {
  capturedAt: new Date().toISOString(),
  label: process.env.PERF_LABEL,
  users: 10,
  exportConcurrency,
  rounds,
  pageSize,
  cases: [],
  errors: [],
  sloViolations: [],
  coverageErrors: [],
  heavy: [],
};
result.rowsAtStart = (
  await api('/api/statistics/custom?includeVoid=1&page=1&pageSize=1')
).json.total;
const output = process.env.PERF_OUTPUT ?? '.scratch/performance/interference.json';
await mkdir(dirname(output), { recursive: true });
const flush = () => writeFile(output, JSON.stringify(result, null, 2) + '\n');
const runId = randomUUID().slice(0, 8);
const browser = await chromium.launch(browserOptions());
result.chromium = browser.version();
const sessions = await Promise.all(
  Array.from({ length: 10 }, async (_, user) => {
    const context = await runtime.context(browser, user);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/api/') && res.status() >= 400)
        errors.push(`API HTTP ${res.status()}`);
    });
    return { context, page, errors, user, project: fixture.projects[user] };
  }),
);
let importNo = 0;
const staged = async (parseOnly = false) => {
  const project = fixture.projects[importNo % 10];
  const prefix = `${runId}-${importNo++}`;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('业务记录');
  sheet.addRow([
    '项目编号',
    '预算年度',
    '科目编码',
    '金额',
    '申请日期',
    '经办人',
    '摘要',
    '业务状态',
    '备注',
    '单据编号',
  ]);
  for (let i = 0; i < 2000; i++)
    sheet.addRow([
      project.code,
      2026,
      'S01',
      '1.25',
      '2026-10-16',
      '性能干扰',
      `干扰-${prefix}-${i}`,
      '登记占位',
      '',
      `PERF-I-${prefix}-${i}`,
    ]);
  const form = new FormData();
  form.set(
    'file',
    new File(
      [Buffer.from(await workbook.xlsx.writeBuffer())],
      `performance-interference-${prefix}.xlsx`,
    ),
  );
  const upload = () => api(`/api/projects/${project.id}/imports`, { method: 'POST', body: form });
  if (parseOnly)
    return async () => {
      const uploaded = await upload();
      const preview = (await api(`/api/projects/${project.id}/imports/${uploaded.json.batchId}`))
        .json;
      assert.equal(preview.valid.length, 2000);
      return uploaded;
    };
  const { batchId } = (await upload()).json;
  const preview = (await api(`/api/projects/${project.id}/imports/${batchId}`)).json;
  assert.equal(preview.valid.length, 2000);
  return () =>
    api(`/api/projects/${project.id}/imports/${batchId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selectedRowIds: preview.valid.map((row) => row.rowId) }),
    });
};
const prepare = async (session, action, round) => {
  const { page, project, user } = session;
  await page.goto(`${base.origin}/projects/${project.id}/records`);
  await recordsReady(page);
  if (pageSize && Number(await page.getByLabel('每页条数').inputValue()) !== pageSize) {
    const resized = page.waitForResponse(
      (res) =>
        isRecords(res) && new URL(res.url()).searchParams.get('pageSize') === String(pageSize),
    );
    await page.getByLabel('每页条数').selectOption(String(pageSize));
    await resized;
    await recordsReady(page);
  }
  const summary = `性能合成业务 干扰-${runId}-${action}-${user}-${round}`;
  if (action === 'filter')
    await page.getByRole('button', { name: '筛选摘要', exact: true }).click();
  if (action === 'create') {
    await page.getByRole('button', { name: '新增', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('combobox', { name: '选择叶科目', exact: true })
      .click();
    await page.getByRole('option', { name: '预算科目1', exact: true }).click();
    await page.getByRole('dialog').getByLabel('金额', { exact: true }).fill('1.25');
    await page.getByRole('dialog').getByLabel('经办人', { exact: true }).fill(`性能用户${user}`);
  } else if (action === 'edit')
    await page.getByRole('button', { name: '修改', exact: true }).first().click();
  if (['create', 'edit'].includes(action))
    await page.getByRole('dialog').getByLabel('摘要', { exact: true }).fill(summary);
  if (['create', 'edit'].includes(action))
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click({ trial: true });
  if (action === 'switch')
    await page.getByRole('link', { name: '执行台账', exact: true }).click({ trial: true });
  if (action === 'create' || action === 'edit')
    await armRecordWrite(page, action === 'edit' ? summary : null);
  else
    await page.evaluate((action) => {
      window.__interactionStart = null;
      window.__interactionReady = null;
      document.addEventListener(
        action === 'filter' ? 'input' : 'click',
        (event) => {
          const element = event.target;
          const matches =
            action === 'filter'
              ? element instanceof HTMLInputElement && element.placeholder === '包含…'
              : element.closest('a')?.getAttribute('href')?.endsWith('/ledger');
          if (matches) window.__interactionStart = performance.now();
        },
        { capture: true },
      );
    }, action);
  assert.equal(session.errors.length, 0, session.errors.join('; '));
  return summary;
};
const operate = async (session, action, summary) => {
  const { page } = session;
  const start = performance.now();
  const stages = {};
  if (action === 'switch') {
    await page.getByRole('link', { name: '执行台账', exact: true }).click();
    await page.waitForURL(/\/ledger$/);
    await page.waitForFunction(
      () =>
        !document.querySelector('main [data-slot="skeleton"]') &&
        document.querySelectorAll('main tbody tr').length > 1,
    );
    await paint(page);
  } else if (action === 'filter') {
    const updated = page.waitForResponse(
      (res) => isRecords(res) && new URL(res.url()).searchParams.has('summary'),
    );
    await page.getByPlaceholder('包含…').fill('性能合成业务');
    await updated;
    await recordsReady(page);
  } else {
    const method = action === 'create' ? 'POST' : 'PATCH';
    const saved = page.waitForResponse(
      (res) =>
        res.request().method() === method &&
        /\/records(?:\/[^/]+)?$/.test(new URL(res.url()).pathname),
    );
    const refreshed = page.waitForResponse(isRecords);
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    const response = await saved;
    stages.writeResponse = performance.now();
    assert.ok(response.ok());
    assert.equal((await response.json()).record.summary, summary);
    await acknowledgeRecordRefresh(page, await refreshed);
    stages.refreshResponse = performance.now();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    stages.dialogClosed = performance.now();
    await recordsReady(page);
    stages.recordsPainted = performance.now();
    if (action === 'edit') await page.getByText(summary, { exact: true }).first().waitFor();
  }
  assert.equal(session.errors.length, 0, session.errors.join('; '));
  if (action === 'create' || action === 'edit')
    await page.waitForFunction(() => window.__interactionReady !== null, undefined, {
      timeout: 15_000,
    });
  const timing = await page.evaluate(() => ({
    start: window.__interactionStart,
    end: performance.now(),
    origin: performance.timeOrigin,
    ready: window.__interactionReady,
  }));
  assert.equal(typeof timing.start, 'number', '没有实际输入事件的证据');
  const write = action === 'create' || action === 'edit';
  if (write)
    assert.ok(
      typeof timing.ready === 'number' && timing.ready > timing.start,
      '没有本次刷新成功及界面绘制完成的证据',
    );
  const completed = write ? timing.ready : timing.end;
  const actualStart = timing.origin + timing.start - performance.timeOrigin;
  return {
    user: session.user + 1,
    start: actualStart,
    end: timing.origin + completed - performance.timeOrigin,
    ms: completed - timing.start,
    observedMs: timing.end - timing.start,
    driverMs: performance.now() - start,
    stagesMs: Object.fromEntries(
      Object.entries(stages).map(([name, end]) => [name, end - actualStart]),
    ),
    uiReadyMs: typeof timing.ready === 'number' ? timing.ready - timing.start : null,
  };
};
try {
  for (const kind of kinds)
    for (const action of actionsToRun) {
      const actions = [];
      const memory = [];
      let timer;
      const sampleMemory = async () => {
        if (!process.env.PERF_APP_PID) return;
        try {
          const text = await readFile(`/proc/${Number(process.env.PERF_APP_PID)}/status`, 'utf8');
          const kb = /VmRSS:\s+(\d+)/.exec(text)?.[1];
          if (kb) memory.push(Number(kb) * 1024);
        } catch {}
      };
      await sampleMemory();
      timer = setInterval(() => {
        void sampleMemory();
      }, 100);
      try {
        for (let round = 0; round < rounds; round++) {
          const importTask = ['import', 'parse'].includes(kind)
            ? await staged(kind === 'parse')
            : null;
          const summaries = await Promise.all(
            sessions.map(async (session) => {
              try {
                return await prepare(session, action, round);
              } catch (error) {
                const ui = await session.page.evaluate(() => ({
                  url: location.pathname + location.search,
                  text: document.querySelector('main')?.textContent?.slice(0, 2000),
                  rows: document.querySelectorAll('main tbody tr').length,
                  busy: document.querySelectorAll('main [aria-busy="true"]').length,
                  skeletons: document.querySelectorAll('main [data-slot="skeleton"]').length,
                }));
                result.errors.push({
                  kind,
                  action,
                  round,
                  user: session.user + 1,
                  stage: 'prepare',
                  error: error.message,
                  ui,
                  browserErrors: session.errors,
                });
                throw error;
              }
            }),
          );
          const heavyStart = performance.now();
          const heavyPromise = (async () => {
            let answer;
            if (['import', 'parse'].includes(kind)) {
              answer = await importTask();
              if (kind === 'import') assert.equal(answer.json.created, 2000);
            }
            if (kind === 'export') {
              const qs = new URLSearchParams({ mode: 'records', tzOffset: '-480' });
              fixture.projects.slice(0, 5).forEach((p) => qs.append('projectIds', p.id));
              const responses = await Promise.all(
                Array.from({ length: exportConcurrency }, () =>
                  api(`/api/statistics/export?${qs}`),
                ),
              );
              answer = { bytes: responses.reduce((sum, res) => sum + res.bytes, 0) };
            }
            if (kind === 'zip')
              answer = await api(`/api/projects/${fixture.projects[0].id}/attachments/export`);
            return {
              kind,
              action,
              start: heavyStart,
              end: performance.now(),
              bytes: answer?.bytes,
            };
          })().then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          const attempts = await Promise.allSettled(
            sessions.map((session, i) => operate(session, action, summaries[i])),
          );
          const heavyResult = await heavyPromise;
          if (heavyResult.error) throw heavyResult.error;
          const heavy = heavyResult.value;
          if (kind !== 'idle') result.heavy.push(heavy);
          for (const attempt of attempts) {
            if (attempt.status === 'rejected') {
              result.errors.push({ kind, action, error: attempt.reason.message });
              continue;
            }
            const sample = attempt.value;
            sample.overlappedHeavy =
              kind !== 'idle' && sample.start < heavy.end && sample.end > heavy.start;
            actions.push(sample);
          }
          await delay(150);
        }
      } finally {
        clearInterval(timer);
      }
      const stats = summarize(actions.map((sample) => sample.ms));
      const overlap = actions.filter((sample) => sample.overlappedHeavy).length;
      if (stats.n !== expectedSamples || overlap !== (kind === 'idle' ? 0 : expectedSamples))
        result.coverageErrors.push({
          kind,
          action,
          n: stats.n,
          overlapped: overlap,
          expected: expectedSamples,
        });
      if (stats.p95 > 1000)
        result.sloViolations.push({ kind, action, targetMs: 1000, actualMs: stats.p95 });
      const row = {
        kind,
        action,
        ms: stats,
        overlapped: overlap,
        actions,
        rssBytes: memory.length
          ? { initial: memory[0], peak: Math.max(...memory), final: memory.at(-1) }
          : null,
      };
      result.cases.push(row);
      await flush();
      console.log(JSON.stringify({ kind, action, ms: stats, overlap, rss: row.rssBytes }));
    }
} catch (error) {
  result.errors.push({ fatal: error.message });
} finally {
  await browser.close();
}
if (result.cases.length !== kinds.length * actionsToRun.length)
  result.coverageErrors.push({
    expectedCases: kinds.length * actionsToRun.length,
    actual: result.cases.length,
  });
await flush();
if (result.errors.length || result.coverageErrors.length) process.exitCode = 1;
else if (result.sloViolations.length) process.exitCode = 2;
