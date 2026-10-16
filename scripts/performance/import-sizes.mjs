import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';
import { localRuntime } from './runtime.mjs';

assert.equal(process.env.PERF_ALLOW_WRITES, '1', '仅写专用合成库，需要PERF_ALLOW_WRITES=1');
const { api, fixture } = await localRuntime();
const project = fixture.projects[0];
const result = { capturedAt: new Date().toISOString(), label: process.env.PERF_LABEL, cases: [] };
result.rowsAtStart = (
  await api('/api/statistics/custom?includeVoid=1&page=1&pageSize=1')
).json.total;
for (const count of [200, 1000, 2000]) {
  const run = randomUUID();
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
  for (let i = 0; i < count; i++)
    sheet.addRow([
      project.code,
      2026,
      'S01',
      '1.25',
      '2026-10-16',
      '性能规模',
      `规模-${run}-${i}`,
      '登记占位',
      '',
      `PERF-S-${run}-${i}`,
    ]);
  const form = new FormData();
  form.set(
    'file',
    new File([Buffer.from(await workbook.xlsx.writeBuffer())], `performance-sizes-${run}.xlsx`),
  );
  const parsed = await api(`/api/projects/${project.id}/imports`, { method: 'POST', body: form });
  const batchId = parsed.json.batchId;
  const preview = await api(`/api/projects/${project.id}/imports/${batchId}`);
  assert.equal(preview.json.valid.length, count);
  const confirmed = await api(`/api/projects/${project.id}/imports/${batchId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selectedRowIds: preview.json.valid.map((row) => row.rowId) }),
  });
  assert.equal(confirmed.json.created, count);
  result.cases.push({
    count,
    batchId,
    parseMs: parsed.ms,
    previewMs: preview.ms,
    confirmMs: confirmed.ms,
    created: confirmed.json.created,
    matched: true,
  });
}
const output = process.env.PERF_OUTPUT ?? '.scratch/performance/import-sizes.json';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
