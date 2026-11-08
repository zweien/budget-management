/**
 * 构建指纹:应用版本(package.json 的 version)与 Prisma 迁移头(最新迁移目录名)。
 * 快照备份与迁移包都记录二者,恢复/导入时与当前环境比对守卫版本偏差(ADR 0003)。
 *
 * 以 process.cwd() 为仓库根(CLI 经 npm run / npx tsx 调用、vitest 亦然)。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function getAppVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string') throw new Error('package.json 缺少 version 字段');
  return pkg.version;
}

export async function getMigrationHead(): Promise<string> {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  const dirs = (await readdir(dir)).filter((d) => /^\d{14}_/.test(d)).sort();
  if (dirs.length === 0) throw new Error(`prisma/migrations 下没有迁移目录(${dir})`);
  return dirs[dirs.length - 1];
}
