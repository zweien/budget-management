import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SignJWT } from 'jose';
import { localRuntime } from './runtime.mjs';

// 两个生产版本指向同一专用夹具，期间不能并发运行写入负载。
const { fixture, api } = await localRuntime();
const original = new URL(process.env.PERF_ORIGINAL_URL ?? 'http://127.0.0.1:3110');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(original.hostname) &&
    Number(original.port) >= 3100 &&
    original.protocol === 'http:',
);
const token = await new SignJWT()
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(fixture.users[0].id)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.PERF_AUTH_SECRET));
const originalJson = async (path) => {
  const response = await fetch(new URL(path, original), {
    redirect: 'manual',
    headers: { cookie: `bm_session=${token}; bm_auth_mode=sso` },
  });
  assert.ok(response.ok, `original HTTP ${response.status}`);
  return response.json();
};
assert.deepEqual(
  (await originalJson('/api/projects')).map((p) => p.id).sort(),
  fixture.projects.map((p) => p.id).sort(),
);
const paths = [
  `/api/projects/${fixture.projects[0].id}/ledger?year=${fixture.year}`,
  `/api/projects/${fixture.projects[0].id}/ledger-total`,
  `/api/statistics/cross-project?year=${fixture.year}`,
  `/api/statistics/custom?projectId=${fixture.projects[0].id}`,
];
const result = { capturedAt: new Date().toISOString(), label: process.env.PERF_LABEL, checks: [] };
for (const path of paths) {
  const before = await originalJson(path);
  const after = (await api(path)).json;
  if (before.records) {
    const byId = (a, b) => a.id.localeCompare(b.id);
    before.records.sort(byId);
    after.records.sort(byId);
  }
  assert.deepEqual(after, before, `版本结果不等价: ${path}`);
  result.checks.push({
    path: path.replace(fixture.projects[0].id, ':project'),
    equal: true,
    ...(after.records ? { rows: after.records.length } : {}),
  });
}
const output = process.env.PERF_OUTPUT ?? '.scratch/performance/equivalence.json';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
