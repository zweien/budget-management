/**
 * 迁移包导出(ADR 0003):单项目「项目信息+预算骨架」的可移植 JSON,跨环境导入用。
 * 不含用户/成员/业务记录/到账/附件/审计/凭证。同名 xlsx(export-project-budget.ts)
 * 是人读报表,本包是机读回导格式,两者并存。
 *
 * 用法: npm run export-package [-- <项目编号|名称关键字> | --all] [--force] [--out <目录>]
 *   --force   项目存在 PENDING(待审批)单时仍导出(默认拒绝)
 *   --all     全部项目逐个导出到目录(缺省 backups/migration-<日期>/)
 * 单项目产物: <目录>/migration-<项目编号>-<日期>.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';

import { prisma } from '@/lib/prisma';
import { exportPackage, MigrationError } from '@/server/services/migrationPackage.service';

function usage(): never {
  console.error(
    '用法: npm run export-package [-- <项目编号|名称关键字> | --all] [--force] [--out <目录>]',
  );
  process.exit(1);
}

function parseArgs() {
  const raw = process.argv.slice(2);
  let ref: string | null = null;
  let all = false;
  let force = false;
  let outDir: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--all') all = true;
    else if (a === '--force') force = true;
    else if (a === '--out') outDir = raw[++i] ?? usage();
    else if (!a.startsWith('--') && ref === null) ref = a;
    else usage();
  }
  if (!all && !ref) usage();
  return { ref, all, force, outDir };
}

const dateTag = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

async function exportOne(
  code: string,
  outDir: string,
  dated: boolean,
  force: boolean,
): Promise<void> {
  const pkg = await exportPackage(code, { force });
  const file = path.join(
    outDir,
    dated
      ? `migration-${pkg.project.code}-${dateTag()}.json`
      : `migration-${pkg.project.code}.json`,
  );
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`✅ 已导出: ${file}`);
  console.log(
    `   ${pkg.project.code} ${pkg.project.name}(${pkg.project.budgetMode === 'LUMP_SUM' ? '包干制' : '一般'};` +
      `科目 ${pkg.subjects.length};调整单 ${pkg.adjustments.length};科目变更 ${pkg.subjectChanges.length})`,
  );
}

async function main() {
  loadEnvConfig(process.cwd());
  const args = parseArgs();

  if (args.all) {
    // 迁移包可分享、快照敏感,分目录存放(backups/migration/ vs backups/ 根)。
    const outDir = args.outDir ?? path.join('backups', 'migration', dateTag());
    await mkdir(outDir, { recursive: true });
    const projects = await prisma.project.findMany({
      select: { code: true },
      orderBy: { code: 'asc' },
    });
    if (projects.length === 0) {
      console.error('系统中没有项目');
      process.exit(1);
    }
    console.log(`共 ${projects.length} 个项目,输出目录: ${path.resolve(outDir)}`);
    let ok = 0;
    const failures: { code: string; error: string }[] = [];
    for (const p of projects) {
      try {
        await exportOne(p.code, outDir, false, args.force);
        ok++;
      } catch (error) {
        failures.push({
          code: p.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    console.log(`完成:成功 ${ok}/${projects.length}`);
    for (const f of failures) console.error(`❌ ${f.code}: ${f.error}`);
    if (failures.length > 0) process.exit(1);
    return;
  }

  const outDir = args.outDir ?? path.join('backups', 'migration');
  await mkdir(outDir, { recursive: true });
  try {
    await exportOne(args.ref!, outDir, true, args.force);
  } catch (e) {
    if (e instanceof MigrationError) {
      console.error(`❌ ${e.message}`);
      for (const d of e.details) console.error(`   ${d}`);
      process.exit(1);
    }
    throw e;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
