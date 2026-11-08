/**
 * 快照恢复(ADR 0003):把 pg_dump 快照整体恢复到目标库(回到导出时刻)。
 *
 * 用法: npm run restore -- <dump文件> [--force] [--allow-skew] [--url <目标DATABASE_URL>]
 * 守卫:
 *   - 版本守卫:dump 同名 .meta.json 的 app/迁移头与当前不一致 → 拒绝(--allow-skew 放行);
 *   - 非空守卫:目标库任何业务表有数据 → 拒绝;--force 时先打印将丢弃的行数概要,
 *     再 DROP SCHEMA public 整体重建(pg_restore --clean 兼容仅建过 schema 的空库)。
 * 恢复后建议:npm run dev 冒烟检查项目/台账/登录。
 */
import { loadEnvConfig } from '@next/env';

import { restoreSnapshot } from './lib/snapshot';

function usage(): never {
  console.error(
    '用法: npm run restore -- <dump文件> [--force] [--allow-skew] [--url <目标DATABASE_URL>]',
  );
  process.exit(1);
}

function parseArgs() {
  const raw = process.argv.slice(2);
  let dump: string | null = null;
  let force = false;
  let allowSkew = false;
  let url: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--force') force = true;
    else if (a === '--allow-skew') allowSkew = true;
    else if (a === '--url') url = raw[++i] ?? usage();
    else if (!a.startsWith('--') && dump === null) dump = a;
    else usage();
  }
  if (!dump) usage();
  return { dump, force, allowSkew, url };
}

async function main() {
  loadEnvConfig(process.cwd());
  const args = parseArgs();
  const explicitUrl = args.url;
  const url = explicitUrl ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('缺少 DATABASE_URL(检查 .env 或用 --url 指定目标库)');
    process.exit(1);
  }

  await restoreSnapshot(args.dump, {
    url,
    force: args.force,
    allowSkew: args.allowSkew,
    // 显式 --url 的目标不是本仓库 compose 库,跳过 compose 载体(socket 连不到别处)。
    allowCompose: !explicitUrl,
    // 丢弃概要在清库**前**打印(ADR 0003),失败也有据可查。
    onDiscard: (counts) => {
      const discarded = Object.entries(counts)
        .filter(([, c]) => c > 0)
        .map(([t, c]) => `${t}=${c}`)
        .join(', ');
      console.log(`⚠ --force:即将丢弃目标库既有数据(清库后 pg_restore 整体重建): ${discarded}`);
    },
  });
  console.log('✅ 快照恢复完成。建议:npm run dev 冒烟检查项目/台账/登录是否正常。');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
