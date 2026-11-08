/**
 * 快照备份(ADR 0003):pg_dump -Fc 全库导出,同环境灾难恢复用。
 * 含用户/凭证哈希/审计等敏感数据,不可外传;.env 不入包。
 *
 * 用法: npm run backup [-- --out <目录>] [--url <DATABASE_URL>]
 * 产物(默认 backups/):budget-snapshot-<时间戳>.dump(600) + .meta.json + .README.txt
 * 定时备份示例见 docs/backup-restore.md(本命令不内置调度)。
 */
import { mkdir } from 'node:fs/promises';
import { loadEnvConfig } from '@next/env';

import { createSnapshot } from './lib/snapshot';

function usage(): never {
  console.error(
    '用法: npm run backup [-- --out <输出目录>] [--url <DATABASE_URL>]  # 缺省读 .env 的 DATABASE_URL',
  );
  process.exit(1);
}

async function main() {
  loadEnvConfig(process.cwd());
  const args = process.argv.slice(2);
  let outDir = 'backups';
  let explicitUrl: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') {
      outDir = args[++i] ?? usage();
    } else if (args[i] === '--url') {
      explicitUrl = args[++i] ?? usage();
    } else {
      usage();
    }
  }
  const url = explicitUrl ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('缺少 DATABASE_URL(检查 .env 或用 --url 指定目标库)');
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const result = await createSnapshot(url, outDir);
  console.log(`✅ 快照备份完成(载体: ${result.meta.carrier})`);
  console.log(`   ${result.dumpPath}(${(result.bytes / 1024 / 1024).toFixed(2)} MB,chmod 600)`);
  console.log(`   ${result.metaPath}`);
  console.log(`   ${result.readmePath}`);
  console.log(`   app ${result.meta.appVersion} / 迁移头 ${result.meta.migrationHead}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
