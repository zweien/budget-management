/**
 * 快照备份往返测试(ADR 0003):backup → 恢复到临时库 → 行数一致 → 守卫。
 * 全程不触碰开发库数据(恢复目标为专用临时库 budget_snapshot_test_*);
 * docker/pg 客户端载体不可用时整体跳过。
 */
import { describe, it, expect } from 'vitest';
import { loadEnvConfig } from '@next/env';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

import {
  createScratchDb,
  detectCarrier,
  dropScratchDb,
  normalizeUrlForPgTools,
  parseDbUrl,
} from '../../scripts/lib/pg-carrier';
import { createSnapshot, restoreSnapshot, snapshotMetaPath } from '../../scripts/lib/snapshot';

loadEnvConfig(process.cwd());
const url = process.env.DATABASE_URL!;

// 往返链路需要 docker 或本机 pg 客户端;scratch 目标必须经 URL 直连(跳过 compose 载体)。
const carrier = detectCarrier({ tool: 'pg_dump', url, allowCompose: false });
const itGated = carrier ? it : it.skip;

describe('pg-carrier parseDbUrl(纯函数)', () => {
  it('解析标准连接串', () => {
    expect(parseDbUrl('postgresql://budget:secret@localhost:5434/budget?schema=public')).toEqual({
      user: 'budget',
      password: 'secret',
      host: 'localhost',
      port: '5434',
      database: 'budget',
    });
  });
  it('协议不符拒绝', () => {
    expect(() => parseDbUrl('mysql://u:p@h/db')).toThrow(/协议/);
  });
  it('缺库名拒绝', () => {
    expect(() => parseDbUrl('postgresql://u:p@h:5432')).toThrow(/库名/);
  });
  it('normalizeUrlForPgTools 剥离 Prisma 专用参数、保留 libpq 参数', () => {
    expect(normalizeUrlForPgTools('postgresql://u:p@h:5432/db?schema=public&sslmode=require')).toBe(
      'postgresql://u:p@h:5432/db?sslmode=require',
    );
    expect(
      normalizeUrlForPgTools('postgresql://u:p@h:5432/db?schema=public&connection_limit=5'),
    ).toBe('postgresql://u:p@h:5432/db');
  });
});

describe(`快照往返(载体: ${carrier ?? '不可用,跳过'})`, () => {
  itGated('backup → 临时库恢复 → 行数一致 → 非空/版本守卫', { timeout: 300_000 }, async () => {
    const scratchName = `budget_snapshot_test_${Date.now().toString(36)}`;
    const dir = await mkdtemp(path.join(tmpdir(), 'budget-snapshot-'));
    let scratchUrl = '';
    try {
      // 1. 快照导出。
      const snap = await createSnapshot(url, dir);
      expect(snap.bytes).toBeGreaterThan(0);
      expect(snap.meta.kind).toBe('budget.snapshot');
      expect(snap.meta.appVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(snap.meta.migrationHead).toMatch(/^\d{14}_/);

      // 2. 临时库恢复(空库,无需 --force)。
      scratchUrl = await createScratchDb(scratchName, { url });
      const res = await restoreSnapshot(snap.dumpPath, { url: scratchUrl, allowCompose: false });
      expect(res.droppedExisting).toBe(false);

      // 3. 关键表行数与源库一致。
      const src = new PrismaClient({ datasourceUrl: url });
      const dst = new PrismaClient({ datasourceUrl: scratchUrl });
      const countAll = async (c: PrismaClient) => ({
        user: await c.user.count(),
        project: await c.project.count(),
        businessRecord: await c.businessRecord.count(),
        auditLog: await c.auditLog.count(),
      });
      try {
        expect(await countAll(dst)).toEqual(await countAll(src));
      } finally {
        await src.$disconnect();
        await dst.$disconnect();
      }

      // 4. 非空守卫:恢复后的临时库再恢复必须拒绝。
      await expect(
        restoreSnapshot(snap.dumpPath, { url: scratchUrl, allowCompose: false }),
      ).rejects.toThrow(/非空/);

      // 5. 版本守卫:篡改 meta 的 appVersion → 拒绝(版本守卫先于非空守卫)。
      const metaPath = snapshotMetaPath(snap.dumpPath);
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      meta.appVersion = '0.0.0';
      await writeFile(metaPath, JSON.stringify(meta), 'utf8');
      await expect(
        restoreSnapshot(snap.dumpPath, { url: scratchUrl, allowCompose: false }),
      ).rejects.toThrow(/版本不一致/);
    } finally {
      if (scratchUrl) await dropScratchDb(scratchName, { url }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
