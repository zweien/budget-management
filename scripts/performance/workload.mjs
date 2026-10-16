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
  delay,
  paint,
  summarize,
  isRecords,
  recordsReady,
} from './runtime.mjs';

if (process.env.PERF_ALLOW_WRITES !== '1')
  throw new Error('混合基准会写入合成记录和导入批次，需 PERF_ALLOW_WRITES=1');
const runtime = await localRuntime();
const { fixture, base, api } = runtime;
assert.ok(
  fixture.users.length >= 10 && fixture.projects.length >= 10,
  '主验收需要10个合成用户及10个项目',
);
const runId = randomUUID().slice(0, 8);
const result = {
  capturedAt: new Date().toISOString(),
  label: process.env.PERF_LABEL,
  users: 10,
  environment:
    'same-host Chromium and production server; desktop 1440x1000, Asia/Shanghai; warm server, independent user sessions',
  projects: fixture.projects.length,
  originalRowsPerProject: fixture.rowsPerProject,
  phases: [],
  sloViolations: [],
  coverageErrors: [],
  heavy: [],
  errors: [],
};
const output = process.env.PERF_OUTPUT ?? '.scratch/performance/workload.json';
await mkdir(dirname(output), { recursive: true });
const flush = () => writeFile(output, JSON.stringify(result, null, 2) + '\n');
const recordHeavy = async (name, task) => {
  const start = performance.now();
  const answer = await task();
  result.heavy.push({
    name,
    start,
    end: performance.now(),
    ms: performance.now() - start,
    bytes: answer?.bytes,
    ...answer?.details,
  });
  return answer;
};
const stage = async (label) => {
  const project = fixture.projects[0];
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
      '性能导入',
      `${runId}-${label}-${i}`,
      '登记占位',
      '',
      `PERF-${runId}-${label}-${i}`,
    ]);
  const file = Buffer.from(await workbook.xlsx.writeBuffer());
  const form = new FormData();
  form.set('file', new File([file], `performance-${runId}-${label}.xlsx`));
  const uploaded = await recordHeavy(`parse-${label}-2000`, () =>
    api(`/api/projects/${project.id}/imports`, { method: 'POST', body: form }),
  );
  const batchId = uploaded.json.batchId;
  const preview = (await api(`/api/projects/${project.id}/imports/${batchId}`)).json;
  assert.equal(preview.valid.length, 2000);
  return { batchId, selectedRowIds: preview.valid.map((row) => row.rowId) };
};
result.rowsAtStart = (
  await api('/api/statistics/custom?includeVoid=1&page=1&pageSize=1')
).json.total;
const staged = await stage('mixed');
const browser = await chromium.launch(browserOptions());
result.chromium = browser.version();
const scenarioPaths = (project) => [
  ['dashboard', '/'],
  ['projects', '/projects'],
  ['records', '/records'],
  ['project', `/projects/${project.id}`],
  ['ledger', `/projects/${project.id}/ledger`],
  ['project-records', `/projects/${project.id}/records`],
  ['statistics', '/statistics'],
  ['imports', `/projects/${project.id}/imports`],
];
const ready = async (page, name) => {
  await page.waitForFunction(
    ({ minimum }) => {
      const main = document.querySelector('main');
      return (
        main &&
        main.textContent.trim() &&
        !main.querySelector('[data-slot="skeleton"]') &&
        !main.textContent.includes('加载中') &&
        !main.textContent.includes('加载失败') &&
        !main.textContent.includes('无法访问') &&
        main.querySelectorAll('tbody tr').length >= minimum
      );
    },
    {
      minimum: ['records', 'project-records'].includes(name)
        ? 2
        : ['projects', 'ledger', 'statistics'].includes(name)
          ? 1
          : 0,
    },
    { timeout: 15_000 },
  );
  await paint(page);
};
try {
  // 预热服务模块；正式样本各用户仍使用独立浏览器上下文。
  const warm = await runtime.context(browser);
  const warmPage = await warm.newPage();
  for (const [name, path] of scenarioPaths(fixture.projects[0])) {
    await warmPage.goto(new URL(path, base).href);
    await ready(warmPage, name);
  }
  await warm.close();
  for (const phase of (process.env.PERF_PHASES ?? 'normal,mixed').split(',')) {
    assert.ok(['normal', 'mixed'].includes(phase));
    const actions = [];
    const memory = [];
    const sampleMemory = async () => {
      if (!process.env.PERF_APP_PID) return;
      try {
        const status = await readFile(`/proc/${Number(process.env.PERF_APP_PID)}/status`, 'utf8');
        memory.push(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]) * 1024);
      } catch {
        /* 未提供/进程已退出时不报告伪造的零值。 */
      }
    };
    await sampleMemory();
    const timer = setInterval(() => {
      void sampleMemory();
    }, 100);
    const phaseStart = performance.now();
    let stopHeavy = false;
    const heavyLoop =
      phase === 'mixed'
        ? (async () => {
            const project = fixture.projects[0];
            let cycle = 0;
            while (!stopHeavy) {
              if (cycle === 0)
                await recordHeavy('confirm-2000', async () => {
                  const res = await api(
                    `/api/projects/${project.id}/imports/${staged.batchId}/confirm`,
                    {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ selectedRowIds: staged.selectedRowIds }),
                    },
                  );
                  assert.equal(res.json.created, 2000);
                  return { ...res, details: { created: res.json.created } };
                });
              if (stopHeavy) break;
              const exportQuery =
                process.env.PERF_LARGE_EXPORT === '1'
                  ? `mode=records&${fixture.projects
                      .slice(0, 5)
                      .map((p) => `projectIds=${p.id}`)
                      .join('&')}&tzOffset=-480`
                  : `mode=records&projectId=${project.id}&budgetYear=2026&entryTimeField=enteredAt&tzOffset=-480`;
              await recordHeavy(
                process.env.PERF_LARGE_EXPORT === '1' ? 'export-50k-class' : 'export-year',
                () => api(`/api/statistics/export?${exportQuery}`),
              );
              if (stopHeavy) break;
              await recordHeavy('zip-24MiB', () =>
                api(`/api/projects/${project.id}/attachments/export`),
              );
              cycle++;
              await delay(150); // 一个重任务通路顺序执行，避免人为无界压入重任务。
            }
          })()
        : Promise.resolve();
    const userWork = Array.from({ length: 10 }, async (_, user) => {
      await delay(user * 120);
      const context = await runtime.context(browser, user);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400)
          errors.push(`API HTTP ${response.status()}`);
      });
      const project = fixture.projects[user];
      const measure = async (name, operation) => {
        const start = performance.now();
        await operation();
        assert.equal(errors.length, 0, errors.join('; '));
        actions.push({
          name,
          user: user + 1,
          start,
          end: performance.now(),
          ms: performance.now() - start,
        });
      };
      try {
        for (let round = 0; round < 2; round++) {
          for (const [name, path] of scenarioPaths(project)) {
            await measure(`navigate-${name}`, async () => {
              await page.goto(new URL(path, base).href);
              await ready(page, name);
            });
            await delay(180 + ((user + round) % 3) * 70);
            if (name !== 'project-records') continue;
            for (let filter = 0; filter < 3; filter++) {
              await page.getByRole('button', { name: '筛选摘要', exact: true }).click();
              const value = filter % 2 === 0 ? '性能合成业务' : '性能合成业务1';
              await measure('filter', async () => {
                const updated = page.waitForResponse(
                  (response) =>
                    isRecords(response) &&
                    new URL(response.url()).searchParams.get('summary') === value,
                );
                await page.getByPlaceholder('包含…').fill(value);
                const data = await (await updated).json();
                assert.ok(data.total > 0);
                await recordsReady(page);
              });
              await page.keyboard.press('Escape');
              await delay(220);
            }
            await page.getByRole('button', { name: '修改', exact: true }).first().click();
            const summary = `性能合成业务 保存-${runId}-${phase}-${user}-${round}`;
            await page.getByRole('dialog').getByLabel('摘要', { exact: true }).fill(summary);
            await measure('save-confirmation', async () => {
              const updated = page.waitForResponse(isRecords);
              const saved = page.waitForResponse(
                (response) =>
                  response.request().method() === 'PATCH' &&
                  /\/records\/[^/]+$/.test(new URL(response.url()).pathname),
              );
              await page
                .getByRole('dialog')
                .getByRole('button', { name: '保存', exact: true })
                .click();
              assert.equal((await saved).status(), 200);
              await updated;
              await page.getByRole('dialog').waitFor({ state: 'hidden' });
              await recordsReady(page);
              await page.getByText(summary, { exact: true }).first().waitFor();
            });
          }
        }
      } catch (error) {
        result.errors.push({ phase, user: user + 1, error: error.message });
      } finally {
        await context.close();
      }
    });
    try {
      await Promise.all(userWork);
    } finally {
      stopHeavy = true;
      await heavyLoop;
      clearInterval(timer);
    }
    const relevantHeavy = result.heavy.filter((task) => task.start >= phaseStart);
    actions.forEach((action) => {
      action.overlappedHeavy = relevantHeavy.some(
        (task) => action.start < task.end && action.end > task.start,
      );
    });
    const groups = [...new Set(actions.map((action) => action.name))].map((name) => {
      const values = actions.filter((action) => action.name === name);
      return {
        name,
        ms: summarize(values.map((action) => action.ms)),
        duringHeavy: summarize(
          values.filter((action) => action.overlappedHeavy).map((action) => action.ms),
        ),
      };
    });
    const expectedCounts = Object.fromEntries([
      ...scenarioPaths(fixture.projects[0]).map(([name]) => [`navigate-${name}`, 20]), ['filter', 60], ['save-confirmation', 20],
    ]);
    for (const [name, expected] of Object.entries(expectedCounts)) {
      const group = groups.find((group) => group.name === name);
      if (!group || group.ms.n !== expected) result.coverageErrors.push({ phase, name, expected, actual: group?.ms.n ?? 0 });
      const targetMs = name.startsWith('navigate-') ? 2000 : 1000;
      if (group?.ms.p95 > targetMs) result.sloViolations.push({ phase, name, targetMs, actualMs: group.ms.p95 });
    }
    result.phases.push({
      phase,
      groups,
      actions,
      rssBytes: memory.length
        ? {
            initial: memory[0],
            peak: Math.max(...memory),
            final: memory.at(-1),
            samples: memory.length,
          }
        : null,
    });
    await flush();
    console.log(
      JSON.stringify({
        phase,
        groups,
        errors: result.errors.length,
        memory: result.phases.at(-1).rssBytes,
      }),
    );
  }
} finally {
  await browser.close();
  await flush();
}
if (result.errors.length || result.coverageErrors.length) process.exitCode = 1;
else if (result.sloViolations.length) process.exitCode = 2;
