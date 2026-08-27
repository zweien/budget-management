/**
 * §issue12 存量修复:重算 project_budgets / annual_budgets 汇总行。
 *
 * 背景:功能联调期间的早期实现曾把追加下达金额同时累加进 initial,且未维持
 * current = initial + adjustment 恒等式,导致部分项目的汇总行与科目层漂移
 * (导出审批表金额翻倍)。科目层(subject_budgets / subject_total_budgets)
 * 经核实为可信真相源,本脚本按其汇总回写两层汇总行。
 *
 * 用法:
 *   npx tsx scripts/recalc-summary-budgets.ts [--dry-run] [projectId ...]
 *   --dry-run      只打印将发生的变更,不写库(缺省即 dry-run,需 --apply 才写)
 *   --apply        实际写入
 *   projectId...   可选,只处理指定项目;缺省处理全部项目
 *
 * 口径:
 *   project_budgets.{initial,adjustment,current} ← Σ subject_total_budgets 同列
 *   annual_budgets.{...}                          ← Σ subject_budgets(当年) 同列
 * (科目层初始编制允许 Σ ≤ projectTotal,故 initial 取科目层汇总而非编制申报值;
 *  如需保留原 initial 请勿对本行使用 --apply。)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const projectIds = args.filter((a) => !a.startsWith('--'));

async function recalcProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { code: true, name: true },
  });
  if (!project) {
    console.log(`跳过 ${projectId}:项目不存在`);
    return;
  }

  const stb = await prisma.subjectTotalBudget.findMany({
    where: { projectId },
    select: { initialAmount: true, adjustmentAmount: true, currentAmount: true },
  });
  const pbBefore = await prisma.projectBudget.findUnique({ where: { projectId } });

  const sum = (
    rows: { initialAmount: unknown; adjustmentAmount: unknown; currentAmount: unknown }[],
  ) => ({
    initial: rows.reduce((a, r) => a + Number(r.initialAmount), 0),
    adjustment: rows.reduce((a, r) => a + Number(r.adjustmentAmount), 0),
    current: rows.reduce((a, r) => a + Number(r.currentAmount), 0),
  });
  const stbSum = sum(stb);

  // 年度:枚举科目层出现过的年份。
  const yearly = await prisma.subjectBudget.groupBy({
    by: ['year'],
    where: { projectId },
    _sum: { initialAmount: true, adjustmentAmount: true, currentAmount: true },
  });

  const fmt = (n: number) => n.toFixed(2);
  let changed = false;

  console.log(`\n== ${project.code} ${project.name} (${projectId})`);
  if (pbBefore) {
    const drift =
      Math.abs(Number(pbBefore.initialAmount) - stbSum.initial) > 0.01 ||
      Math.abs(Number(pbBefore.adjustmentAmount) - stbSum.adjustment) > 0.01 ||
      Math.abs(Number(pbBefore.currentAmount) - stbSum.current) > 0.01;
    console.log(
      `  project_budgets: ${fmt(Number(pbBefore.initialAmount))}/${fmt(Number(pbBefore.adjustmentAmount))}/${fmt(Number(pbBefore.currentAmount))}` +
        ` → ${fmt(stbSum.initial)}/${fmt(stbSum.adjustment)}/${fmt(stbSum.current)}${drift ? '  [漂移,将修复]' : '  [一致]'}`,
    );
    if (drift) changed = true;
  }

  for (const y of yearly) {
    const abBefore = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId, year: y.year } },
    });
    const target = {
      initial: Number(y._sum.initialAmount ?? 0),
      adjustment: Number(y._sum.adjustmentAmount ?? 0),
      current: Number(y._sum.currentAmount ?? 0),
    };
    const drift =
      !abBefore ||
      Math.abs(Number(abBefore.initialAmount) - target.initial) > 0.01 ||
      Math.abs(Number(abBefore.adjustmentAmount) - target.adjustment) > 0.01 ||
      Math.abs(Number(abBefore.currentAmount) - target.current) > 0.01;
    console.log(
      `  annual_budgets(${y.year}): ${abBefore ? `${fmt(Number(abBefore.initialAmount))}/${fmt(Number(abBefore.adjustmentAmount))}/${fmt(Number(abBefore.currentAmount))}` : '(缺失)'}` +
        ` → ${fmt(target.initial)}/${fmt(target.adjustment)}/${fmt(target.current)}${drift ? '  [漂移,将修复]' : '  [一致]'}`,
    );
    if (drift) changed = true;
  }

  if (!apply) return;
  if (!changed) {
    console.log('  无变更。');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.projectBudget.upsert({
      where: { projectId },
      create: {
        projectId,
        initialAmount: stbSum.initial.toFixed(2),
        adjustmentAmount: stbSum.adjustment.toFixed(2),
        currentAmount: stbSum.current.toFixed(2),
      },
      update: {
        initialAmount: stbSum.initial.toFixed(2),
        adjustmentAmount: stbSum.adjustment.toFixed(2),
        currentAmount: stbSum.current.toFixed(2),
      },
    });
    for (const y of yearly) {
      const data = {
        initialAmount: Number(y._sum.initialAmount ?? 0).toFixed(2),
        adjustmentAmount: Number(y._sum.adjustmentAmount ?? 0).toFixed(2),
        currentAmount: Number(y._sum.currentAmount ?? 0).toFixed(2),
      };
      await tx.annualBudget.upsert({
        where: { projectId_year: { projectId, year: y.year } },
        create: { id: crypto.randomUUID(), projectId, year: y.year, ...data },
        update: data,
      });
    }
  });
  console.log('  已写库 ✓');
}

async function main() {
  const ids =
    projectIds.length > 0
      ? projectIds
      : (await prisma.project.findMany({ select: { id: true }, where: { archivedAt: null } })).map(
          (p) => p.id,
        );
  for (const id of ids) {
    await recalcProject(id);
  }
  if (!apply) {
    console.log('\n(dry-run,未写库。确认后加 --apply 执行。)');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
