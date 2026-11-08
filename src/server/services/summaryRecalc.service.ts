/**
 * 汇总行校验/修复引擎(ADR 0003):以科目层(subject_total_budgets / subject_budgets)
 * 为真值校验 project_budgets / annual_budgets,漂移>0.01 时按 Σ 修复。
 *
 * 迁移包导入与 recalc-summary-budgets 脚本的 --from-subjects 模式共用本引擎,
 * 口径单一来源:FOR UPDATE 行锁(与 approveAdjustment 同锁)、0.01 阈值、
 * 初始编制须 APPROVED 的门槛(草稿期 current=0 是设计语义,不是漂移)。
 *
 * 预算类型差异:一般(GENERAL)项目层取 Σ 科目总预算并修复;包干制(LUMP_SUM)
 * 无科目总预算层,项目层只做恒等式报告不盲改(总值是批复口径),年度层仍按
 * Σ 科目×年度明细校验修复(此前脚本版对包干制项目层会误清零,引擎已修正)。
 */
import { prisma } from '@/lib/prisma';

export interface SummaryVerifyResult {
  mode: 'recalculated' | 'lump-sum-report' | 'skipped-draft';
  lines: string[];
  fixed: boolean;
}

interface Triple {
  initial: number;
  adjustment: number;
  current: number;
}

const n = (v: unknown) => Number(v ?? 0);
const fmt = (x: number) => x.toFixed(2);
const drifted = (a: Triple, b: Triple) =>
  Math.abs(a.initial - b.initial) > 0.01 ||
  Math.abs(a.adjustment - b.adjustment) > 0.01 ||
  Math.abs(a.current - b.current) > 0.01;

export async function verifyAndFixProjectSummaries(
  projectId: string,
  opts: { apply: boolean },
): Promise<SummaryVerifyResult> {
  const initApp = await prisma.initialBudgetApplication.findUnique({
    where: { projectId },
    select: { status: true },
  });
  // 草稿期汇总 current=0 是设计语义(recalc-summary-budgets 同款门槛),不是漂移。
  if (!initApp || initApp.status !== 'APPROVED') {
    return {
      mode: 'skipped-draft',
      lines: ['初始编制未审批生效(current=0 属正常语义),跳过汇总校验'],
      fixed: false,
    };
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { budgetMode: true },
  });
  if (!project) {
    return { mode: 'skipped-draft', lines: ['项目不存在,跳过汇总校验'], fixed: false };
  }

  const lines: string[] = [];
  let fixed = false;

  await prisma.$transaction(async (tx) => {
    // 与 approveAdjustment / recalc-summary-budgets 同锁:锁内重读再写。
    await tx.$queryRaw`SELECT project_id FROM project_budgets WHERE project_id = ${projectId}::uuid FOR UPDATE`;

    const pb = await tx.projectBudget.findUnique({ where: { projectId } });
    if (!pb) {
      lines.push('project_budgets 缺失(包未携带项目汇总行),跳过');
      return;
    }
    const before: Triple = {
      initial: n(pb.initialAmount),
      adjustment: n(pb.adjustmentAmount),
      current: n(pb.currentAmount),
    };

    if (project.budgetMode === 'GENERAL') {
      // 一般项目:两层都取科目层 Σ(subject_total_budgets / subject_budgets),漂移即修复。
      const stb = await tx.subjectTotalBudget.findMany({
        where: { projectId },
        select: { initialAmount: true, adjustmentAmount: true, currentAmount: true },
      });
      const target: Triple = {
        initial: stb.reduce((a, r) => a + n(r.initialAmount), 0),
        adjustment: stb.reduce((a, r) => a + n(r.adjustmentAmount), 0),
        current: stb.reduce((a, r) => a + n(r.currentAmount), 0),
      };
      if (drifted(before, target)) {
        lines.push(
          `project_budgets: ${fmt(before.initial)}/${fmt(before.adjustment)}/${fmt(before.current)} → ${fmt(target.initial)}/${fmt(target.adjustment)}/${fmt(target.current)} [按科目层修复]`,
        );
        if (opts.apply) {
          await tx.projectBudget.update({
            where: { projectId },
            data: {
              initialAmount: target.initial.toFixed(2),
              adjustmentAmount: target.adjustment.toFixed(2),
              currentAmount: target.current.toFixed(2),
            },
          });
          fixed = true;
        }
      } else {
        lines.push('project_budgets: 自洽');
      }
    } else {
      // 包干制:无科目总预算层,项目层只做恒等式报告,不盲改(总值是批复口径)。
      const identity = before.initial + before.adjustment;
      lines.push(
        Math.abs(before.current - identity) > 0.01
          ? `project_budgets(包干制): current ${fmt(before.current)} ≠ initial+adjustment ${fmt(identity)}(仅报告,未修改)`
          : 'project_budgets(包干制): 自洽',
      );
    }

    // 年度层:两种预算类型都有科目×年度明细,统一按 Σ subject_budgets 校验修复。
    const [subjectYears, annualRows] = await Promise.all([
      tx.subjectBudget.groupBy({ by: ['year'], where: { projectId } }),
      tx.annualBudget.findMany({ where: { projectId }, orderBy: { year: 'asc' } }),
    ]);
    const years = new Set<number>([
      ...subjectYears.map((r) => r.year),
      ...annualRows.map((r) => r.year),
    ]);
    for (const year of [...years].sort((a, b) => a - b)) {
      const ab = annualRows.find((r) => r.year === year);
      if (!ab) {
        lines.push(`annual_budgets(${year}): 无汇总行(仅报告,未补建)`);
        continue;
      }
      const beforeY: Triple = {
        initial: n(ab.initialAmount),
        adjustment: n(ab.adjustmentAmount),
        current: n(ab.currentAmount),
      };
      const sbs = await tx.subjectBudget.findMany({
        where: { projectId, year },
        select: { initialAmount: true, adjustmentAmount: true, currentAmount: true },
      });
      const targetY: Triple = {
        initial: sbs.reduce((a, r) => a + n(r.initialAmount), 0),
        adjustment: sbs.reduce((a, r) => a + n(r.adjustmentAmount), 0),
        current: sbs.reduce((a, r) => a + n(r.currentAmount), 0),
      };
      if (drifted(beforeY, targetY)) {
        lines.push(
          `annual_budgets(${year}): ${fmt(beforeY.initial)}/${fmt(beforeY.adjustment)}/${fmt(beforeY.current)} → ${fmt(targetY.initial)}/${fmt(targetY.adjustment)}/${fmt(targetY.current)} [按科目层修复]`,
        );
        if (opts.apply) {
          await tx.annualBudget.update({
            where: { id: ab.id },
            data: {
              initialAmount: targetY.initial.toFixed(2),
              adjustmentAmount: targetY.adjustment.toFixed(2),
              currentAmount: targetY.current.toFixed(2),
            },
          });
          fixed = true;
        }
      } else {
        lines.push(`annual_budgets(${year}): 自洽`);
      }
    }
  });

  return {
    mode: project.budgetMode === 'GENERAL' ? 'recalculated' : 'lump-sum-report',
    lines,
    fixed,
  };
}
