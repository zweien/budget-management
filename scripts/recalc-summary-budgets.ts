/**
 * §issue12 存量修复:修复 project_budgets / annual_budgets 汇总行漂移。
 *
 * 背景:功能联调期间的早期实现曾把追加下达金额同时累加进 initial,且未维持
 * current = initial + adjustment 恒等式,导致部分项目的汇总行漂移(导出审批表
 * 金额翻倍,如"培养对象-姚雯")。
 *
 * 两种修复模式(默认 fix-identity,--from-subjects 显式覆盖):
 * - fix-identity(保守,默认):仅当账本自身破恒等式(current ≠ initial + adjustment)
 *   时,重算 current = initial + adjustment。initial 视为权威申报额,绝不改动——
 *   编制允许 Σ科目 ≤ 总盘,科目合计小于总盘的未分配余额是合法状态,不得缩水。
 * - from-subjects(激进):initial 本身已被历史 bug 污染(无法从现有数据恢复申报额)
 *   时使用——三列全部改取科目层汇总(Σ subject_total_budgets / Σ subject_budgets)。
 *   会覆盖 initial,须逐项目人工确认后执行。
 *
 * 并发安全:--apply 在事务内先 FOR UPDATE 锁定 project_budgets 行(与
 * approveAdjustment 的追加审批同锁),锁内重读科目层与汇总行后再写入,
 * 不会用旧快照覆盖并发审批刚更新的额度。
 *
 * 用法:
 *   npx tsx scripts/recalc-summary-budgets.ts [--apply] [--from-subjects] [projectId ...]
 *   缺省 dry-run 只打印;--apply 写库;projectId 缺省 = 全部未归档项目。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fromSubjects = args.includes('--from-subjects');
const projectIds = args.filter((a) => !a.startsWith('--'));

const n = (v: unknown) => Number(v ?? 0);
const fmt = (x: number) => x.toFixed(2);

interface Triple {
  initial: number;
  adjustment: number;
  current: number;
}

/** fix-identity 模式目标:initial/adjustment 保持,current 改为恒等式值。 */
function identityTarget(t: Triple): Triple {
  return { initial: t.initial, adjustment: t.adjustment, current: t.initial + t.adjustment };
}

function drifted(a: Triple, b: Triple): boolean {
  return (
    Math.abs(a.initial - b.initial) > 0.01 ||
    Math.abs(a.adjustment - b.adjustment) > 0.01 ||
    Math.abs(a.current - b.current) > 0.01
  );
}

async function recalcProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { code: true, name: true },
  });
  if (!project) {
    console.log(`跳过 ${projectId}:项目不存在`);
    return;
  }

  // 只处理编制已生效的项目:草稿期汇总行 current=0 是 §6.3 设计语义(审批时
  // current←initial 置位),不是漂移,不得"修复"。
  const initApp = await prisma.initialBudgetApplication.findUnique({
    where: { projectId },
    select: { status: true },
  });
  if (!initApp || initApp.status !== 'APPROVED') {
    console.log(
      `跳过 ${project.code} ${project.name}:初始预算编制未审批生效(${initApp?.status ?? '无'}),草稿期 current=0 属正常语义`,
    );
    return;
  }

  console.log(
    `\n== ${project.code} ${project.name} (${projectId})${fromSubjects ? ' [from-subjects]' : ''}`,
  );

  await prisma.$transaction(async (tx) => {
    // 与 approveAdjustment 同锁:并发审批要么在本事务前提交(读到新值),
    // 要么等待本事务提交(其容量校验/写入基于修复后快照),不会互相覆盖。
    await tx.$queryRaw`SELECT project_id FROM project_budgets WHERE project_id = ${projectId}::uuid FOR UPDATE`;

    const pb = await tx.projectBudget.findUnique({ where: { projectId } });
    const stb = await tx.subjectTotalBudget.findMany({
      where: { projectId },
      select: { initialAmount: true, adjustmentAmount: true, currentAmount: true },
    });
    const stbSum: Triple = {
      initial: stb.reduce((a, r) => a + n(r.initialAmount), 0),
      adjustment: stb.reduce((a, r) => a + n(r.adjustmentAmount), 0),
      current: stb.reduce((a, r) => a + n(r.currentAmount), 0),
    };

    if (pb) {
      const before: Triple = {
        initial: n(pb.initialAmount),
        adjustment: n(pb.adjustmentAmount),
        current: n(pb.currentAmount),
      };
      const target = fromSubjects ? stbSum : identityTarget(before);
      const bad = drifted(before, target);
      console.log(
        `  project_budgets: ${fmt(before.initial)}/${fmt(before.adjustment)}/${fmt(before.current)}` +
          ` → ${fmt(target.initial)}/${fmt(target.adjustment)}/${fmt(target.current)}` +
          `${bad ? (fromSubjects ? '  [from-subjects 覆盖]' : '  [恒等式修复]') : '  [自洽]'}` +
          (fromSubjects
            ? `  (科目层 Σ: ${fmt(stbSum.initial)}/${fmt(stbSum.adjustment)}/${fmt(stbSum.current)})`
            : ''),
      );
      if (bad && apply) {
        await tx.projectBudget.update({
          where: { projectId },
          data: {
            initialAmount: target.initial.toFixed(2),
            adjustmentAmount: target.adjustment.toFixed(2),
            currentAmount: target.current.toFixed(2),
          },
        });
      } else if (bad && !apply) {
        console.log('    (dry-run,未写库)');
      }
    } else {
      console.log('  project_budgets: (缺失,跳过——须先完成初始预算编制审批)');
    }

    // 年度:枚举科目层出现过的年份。
    const years = await tx.subjectBudget.groupBy({ by: ['year'], where: { projectId } });
    for (const { year } of years) {
      const sbs = await tx.subjectBudget.findMany({
        where: { projectId, year },
        select: { initialAmount: true, adjustmentAmount: true, currentAmount: true },
      });
      const sbSum: Triple = {
        initial: sbs.reduce((a, r) => a + n(r.initialAmount), 0),
        adjustment: sbs.reduce((a, r) => a + n(r.adjustmentAmount), 0),
        current: sbs.reduce((a, r) => a + n(r.currentAmount), 0),
      };
      const ab = await tx.annualBudget.findUnique({
        where: { projectId_year: { projectId, year } },
      });
      if (!ab) {
        console.log(`  annual_budgets(${year}): (缺失,跳过)`);
        continue;
      }
      const before: Triple = {
        initial: n(ab.initialAmount),
        adjustment: n(ab.adjustmentAmount),
        current: n(ab.currentAmount),
      };
      const target = fromSubjects ? sbSum : identityTarget(before);
      const bad = drifted(before, target);
      console.log(
        `  annual_budgets(${year}): ${fmt(before.initial)}/${fmt(before.adjustment)}/${fmt(before.current)}` +
          ` → ${fmt(target.initial)}/${fmt(target.adjustment)}/${fmt(target.current)}` +
          `${bad ? (fromSubjects ? '  [from-subjects 覆盖]' : '  [恒等式修复]') : '  [自洽]'}`,
      );
      if (bad && apply) {
        await tx.annualBudget.update({
          where: { id: ab.id },
          data: {
            initialAmount: target.initial.toFixed(2),
            adjustmentAmount: target.adjustment.toFixed(2),
            currentAmount: target.current.toFixed(2),
          },
        });
      } else if (bad && !apply) {
        console.log('    (dry-run,未写库)');
      }
    }

    if (!apply) console.log('    (本事务未写库)');
  });
}

async function main() {
  const mode = fromSubjects ? 'from-subjects(覆盖 initial,慎用)' : 'fix-identity(保守,保留申报额)';
  console.log(`模式:${mode}${apply ? ' [--apply]' : ' [dry-run]'}`);
  const ids =
    projectIds.length > 0
      ? projectIds
      : (await prisma.project.findMany({ select: { id: true }, where: { archivedAt: null } })).map(
          (p) => p.id,
        );
  for (const id of ids) {
    await recalcProject(id);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
