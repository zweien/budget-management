/**
 * 迁移包导入(ADR 0003):把 export-package 产出的 JSON 包导入本环境。
 *
 * 用法: npm run import-package -- <包文件> [--overwrite] [--owner <姓名|SSO sub>] [--allow-skew]
 * 守卫与语义:
 *   - 同项目编号冲突默认拒绝;--overwrite 整体替换,但仅限目标项目骨架态
 *     (无业务记录/到账/导入批次),已有业务数据时硬拒绝、无绕过通道;
 *   - 包/环境版本不一致默认拒绝(--allow-skew 放行);
 *   - 必填 User 引用重映射到 --owner 用户;缺省以最早 ADMIN 占位负责人并警告(不建成员);
 *   - 单事务全或无;导入后按科目层自动校验/修复汇总行并打印差异。
 */
import { loadEnvConfig } from '@next/env';

import { prisma } from '@/lib/prisma';
import {
  importPackage,
  readPackageFile,
  MigrationError,
} from '@/server/services/migrationPackage.service';

function usage(): never {
  console.error(
    '用法: npm run import-package -- <包文件> [--overwrite] [--owner <姓名|SSO sub UUID>] [--allow-skew]',
  );
  process.exit(1);
}

function parseArgs() {
  const raw = process.argv.slice(2);
  let file: string | null = null;
  let overwrite = false;
  let ownerKey: string | undefined;
  let allowSkew = false;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--overwrite') overwrite = true;
    else if (a === '--allow-skew') allowSkew = true;
    else if (a === '--owner') ownerKey = raw[++i] ?? usage();
    else if (!a.startsWith('--') && file === null) file = a;
    else usage();
  }
  if (!file) usage();
  return { file, overwrite, ownerKey, allowSkew };
}

function printReport(report: Awaited<ReturnType<typeof importPackage>>): void {
  console.log(
    `✅ 导入完成: ${report.projectCode} ${report.projectName}${report.replacedExisting ? '(--overwrite 替换既有项目)' : ''}`,
  );
  const ins = report.inserted;
  console.log(
    `   科目 ${ins.subjects};年度 ${ins.annualBudgets};科目×年度 ${ins.subjectBudgets};科目总 ${ins.subjectTotalBudgets};调整单 ${ins.adjustments}(明细 ${ins.adjustmentLines});科目变更 ${ins.subjectChanges}`,
  );
  if (report.owner.mode === 'claimed') {
    console.log(`   已认领 OWNER: ${report.owner.userName}(${report.owner.userId})`);
  }
  for (const w of report.warnings) console.log(`   ⚠ ${w}`);
  const remapped = report.userRefActions.filter((r) => r.action !== 'kept');
  if (remapped.length > 0) {
    console.log(`   User 引用调整 ${remapped.length} 处(原名见包内 provenance):`);
    for (const r of remapped) {
      const label = r.action === 'remapped' ? `→ ${report.owner.userName}` : '→ 置空';
      console.log(`     ${r.field}: ${r.originalUserName ?? r.originalUserId} ${label}`);
    }
  }
  console.log(`   汇总校验(${report.summaryCheck.mode}):`);
  for (const line of report.summaryCheck.lines) console.log(`     ${line}`);
}

async function main() {
  loadEnvConfig(process.cwd());
  const args = parseArgs();
  const pkg = await readPackageFile(args.file);
  try {
    const report = await importPackage(pkg, {
      overwrite: args.overwrite,
      ownerKey: args.ownerKey,
      allowSkew: args.allowSkew,
    });
    printReport(report);
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
