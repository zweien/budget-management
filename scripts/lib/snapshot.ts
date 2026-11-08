/**
 * 快照备份的核心逻辑(ADR 0003):pg_dump -Fc 全库导出 + 带守卫的恢复。
 * CLI 壳(scripts/backup.ts / scripts/restore.ts)与往返测试共用本模块。
 *
 * 产物三件套(写入 backups/):
 *   - budget-snapshot-<时间戳>.dump         pg_dump custom 格式全库(含 schema 与数据)
 *   - budget-snapshot-<时间戳>.meta.json    appVersion / migrationHead / exportedAt / carrier
 *   - budget-snapshot-<时间戳>.README.txt   恢复步骤说明
 * .env 一律不入包(密钥不随备份流转);dump 文件 chmod 600。
 */
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';

import { getAppVersion, getMigrationHead } from '@/lib/build-info';
import { parseDbUrl, runPgTool, type PgCarrier } from './pg-carrier';

export interface SnapshotMeta {
  kind: 'budget.snapshot';
  appVersion: string;
  migrationHead: string;
  exportedAt: string;
  carrier: PgCarrier;
  database: string;
}

export function snapshotMetaPath(dumpPath: string): string {
  return `${dumpPath}.meta.json`;
}

export function timestampSlug(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export interface CreateSnapshotResult {
  dumpPath: string;
  metaPath: string;
  readmePath: string;
  meta: SnapshotMeta;
  bytes: number;
}

/** 导出全库快照到 outDir,返回产物路径。 */
export async function createSnapshot(url: string, outDir: string): Promise<CreateSnapshotResult> {
  const [appVersion, migrationHead] = await Promise.all([getAppVersion(), getMigrationHead()]);
  const base = `budget-snapshot-${timestampSlug()}`;
  const dumpPath = path.join(outDir, `${base}.dump`);
  const metaPath = snapshotMetaPath(dumpPath);
  const readmePath = path.join(outDir, `${base}.README.txt`);

  const { carrier } = await runPgTool('pg_dump', ['-Fc'], { url, stdoutFile: dumpPath });
  await chmod(dumpPath, 0o600);

  const meta: SnapshotMeta = {
    kind: 'budget.snapshot',
    appVersion,
    migrationHead,
    exportedAt: new Date().toISOString(),
    carrier,
    database: parseDbUrl(url).database,
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await writeFile(readmePath, snapshotReadme(meta, dumpPath), 'utf8');
  await chmod(metaPath, 0o600);
  await chmod(readmePath, 0o600);

  return { dumpPath, metaPath, readmePath, meta, bytes: (await stat(dumpPath)).size };
}

function snapshotReadme(meta: SnapshotMeta, dumpPath: string): string {
  return [
    `快照备份(ADR 0003)——同环境灾难恢复用,含用户/凭证哈希/审计,敏感数据不可外传。`,
    ``,
    `导出时间: ${meta.exportedAt}`,
    `应用版本: ${meta.appVersion}`,
    `迁移头:   ${meta.migrationHead}`,
    `库:       ${meta.database}`,
    ``,
    `恢复步骤(目标库非空会拒绝,确认丢弃请加 --force):`,
    `  npm run restore -- ${path.basename(dumpPath)} [--url <目标DATABASE_URL>]`,
    ``,
    `.env 不在备份内:恢复前请自行准备环境变量(AUTH_SECRET / Authentik / DATABASE_URL)。`,
  ].join('\n');
}

/**
 * 非空检查:统计 public 下全部业务表的行数(_prisma_migrations 除外——
 * 「跑过迁移但零数据」的库视为空,可无 --force 恢复)。全表口径,不抽样。
 */
export async function targetTableCounts(url: string): Promise<Record<string, number>> {
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>(
      Prisma.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
    );
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const res = await prisma.$queryRaw<Array<{ cnt: number }>>(
        Prisma.sql`SELECT count(*)::int AS cnt FROM ${Prisma.sql([`"${t.table_name}"`])}`,
      );
      counts[t.table_name] = Number(res[0]?.cnt ?? 0);
    }
    return counts;
  } finally {
    await prisma.$disconnect();
  }
}

export interface RestoreSnapshotOptions {
  url: string;
  /** 版本不一致时的显式放行。 */
  allowSkew?: boolean;
  /** 目标库非空时丢弃既有数据(丢弃概要经 onDiscard 在清库**前**报告)。 */
  force?: boolean;
  /** 清库前回调:打印将丢弃的行数概要(在 DROP 之前,失败也不至于无据可查)。 */
  onDiscard?: (counts: Record<string, number>) => void;
  /** 目标即本仓库 compose 库(未显式 --url)时可走 compose 载体;--url 覆盖后必须直连。 */
  allowCompose?: boolean;
}

export interface RestoreSnapshotResult {
  droppedExisting: boolean;
  countsBefore: Record<string, number> | null;
}

/**
 * 恢复快照到目标库:
 * 1) meta 版本守卫(appVersion/migrationHead 不一致默认拒绝);
 * 2) 非空守卫(有数据默认拒绝,--force 先 DROP SCHEMA public 再恢复);
 * 3) pg_restore --no-owner --no-privileges(经 pg-carrier 载体)。
 */
export async function restoreSnapshot(
  dumpPath: string,
  opts: RestoreSnapshotOptions,
): Promise<RestoreSnapshotResult> {
  // 1. 版本守卫:meta 与当前应用比对。
  let meta: SnapshotMeta | null = null;
  try {
    meta = JSON.parse(await readFile(snapshotMetaPath(dumpPath), 'utf8'));
  } catch {
    meta = null;
  }
  if (!meta || meta.kind !== 'budget.snapshot') {
    if (!opts.allowSkew) {
      throw new Error(
        `快照缺元数据文件(${path.basename(snapshotMetaPath(dumpPath))}),无法校验版本;` +
          `确认来源可信后加 --allow-skew 放行。`,
      );
    }
  } else {
    const [appVersion, migrationHead] = await Promise.all([getAppVersion(), getMigrationHead()]);
    if (meta.appVersion !== appVersion || meta.migrationHead !== migrationHead) {
      if (!opts.allowSkew) {
        throw new Error(
          `版本不一致,默认拒绝恢复:\n` +
            `  快照:   app ${meta.appVersion} / 迁移头 ${meta.migrationHead}(${meta.exportedAt})\n` +
            `  当前:   app ${appVersion} / 迁移头 ${migrationHead}\n` +
            `schema 错位的半失败恢复最难收拾;确认自担风险请加 --allow-skew。`,
        );
      }
    }
  }

  // 2. 非空守卫(全表口径;_prisma_migrations 不算数据)。
  const counts = await targetTableCounts(opts.url);
  const nonEmpty = Object.values(counts).some((n) => n > 0);
  let droppedExisting = false;
  if (nonEmpty) {
    if (!opts.force) {
      const summary = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}=${n}`)
        .join(', ');
      throw new Error(
        `目标库非空(${summary}),默认拒绝恢复。` +
          `确认丢弃全部数据请加 --force(将 DROP SCHEMA public 后整体重建)。`,
      );
    }
    // 先报告后清库:即便后续 pg_restore 中途失败,丢了什么已有据可查(ADR 0003)。
    opts.onDiscard?.(counts);
    droppedExisting = true;
    await runPgTool(
      'psql',
      ['-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE;', '-c', 'CREATE SCHEMA public;'],
      { url: opts.url, allowCompose: opts.allowCompose },
    );
  }

  // 3. 恢复。--clean --if-exists 兼容「零数据但 schema 已建」的目标库。
  // --url 覆盖时由调用方置 allowCompose=false(socket 连不到别处的库)。
  await runPgTool('pg_restore', ['--no-owner', '--no-privileges', '--clean', '--if-exists'], {
    url: opts.url,
    inputFile: dumpPath,
    allowCompose: opts.allowCompose,
  });
  return { droppedExisting, countsBefore: nonEmpty ? counts : null };
}
