import { cp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const [mode, directory] = process.argv.slice(2);
if (!['build', 'start'].includes(mode) || !directory) {
  throw new Error('用法：node scripts/performance/app.mjs build|start <独立工作区>');
}
const root = resolve(directory);
if (root === process.cwd()) throw new Error('请使用独立工作区，避免覆盖当前开发构建');
const pkg = JSON.parse(await readFile(join(root, 'package.json')));
if (pkg.name !== 'budget-management') throw new Error('工作区不是 budget-management');
const databaseUrl = process.env.PERF_DATABASE_URL;
if (!databaseUrl) throw new Error('必须显式设置 PERF_DATABASE_URL');
const target = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
  !/^\/budget_perf_[a-z0-9_]+$/.test(target.pathname)
) {
  throw new Error('仅支持本机 budget_perf_* 专用数据库');
}
const secret = process.env.PERF_AUTH_SECRET;
if (!secret || secret.length < 32) throw new Error('必须设置专用 PERF_AUTH_SECRET（至少32字符）');
const port = Number(process.env.PERF_PORT ?? 3110);
if (!Number.isInteger(port) || port < 3100 || port > 65535) throw new Error('PERF_PORT 无效');
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  NODE_ENV: 'production',
  MOCK_AUTH: 'false',
  AUTH_SECRET: secret,
  AUTHENTIK_ISSUER: 'http://127.0.0.1:9000/application/o/performance/',
  AUTHENTIK_CLIENT_ID: 'performance-only',
  AUTHENTIK_CLIENT_SECRET: 'performance-only',
  APP_BASE_URL: `http://127.0.0.1:${port}`,
  HOSTNAME: '127.0.0.1',
  PORT: String(port),
};
if (mode === 'start') {
  await cp(join(root, 'public'), join(root, '.next/standalone/public'), { recursive: true });
  await cp(join(root, '.next/static'), join(root, '.next/standalone/.next/static'), {
    recursive: true,
  });
}
const child = spawn(
  process.execPath,
  mode === 'build'
    ? [join(root, 'node_modules/next/dist/bin/next'), 'build']
    : [join(root, '.next/standalone/server.js')],
  { cwd: root, env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
