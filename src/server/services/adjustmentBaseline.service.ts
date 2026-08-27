import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { D, fromStored } from '@/lib/decimal';

/** 基线重建所需的最小单据字段(adjustment + lines)。 */
export interface BaselineAdjustmentInput {
  id: string;
  projectId: string;
  year: number;
  kind: string | null;
  expandTotals: boolean;
  status: string;
  approvedAt: Date | null;
  lines: {
    subjectId: string | null;
    year: number;
    totalAdjustment: string | Prisma.Decimal;
    annualAdjustment: string | Prisma.Decimal;
  }[];
}

/** 科目余额基线:总预算 / 年度(某单一年份)维度,键为科目 id。 */
export interface BaselineAmounts {
  total: Map<string, D>;
  annual: Map<string, D>;
}

/**
 * 科目余额基线重建(§issue12 导出审批表 / §issue15 审批详情共用)。
 *
 * 库内 currentAmount 是"活值":已含本单(若已生效)与全部更晚生效调整单的 delta。
 * "原预算"须还原到参照时点的快照:live − 本单(若已生效)− 参照时点之后生效的单据
 * (同科目;年度维度仅扣同年行)。
 *
 * - 导出场景(已生效单):refAt 不传,参照 = 本单 approvedAt,与历史行为一致;
 *   未生效单(草稿/待审/驳回)不做任何扣减,直接返回 live。
 * - 详情场景(待审单):refAt 传单据 createdAt → 得到"提交时刻"基线
 *   (提交后他单审批生效的 delta 被剔除;本单未生效,不参与扣减)。
 */
export async function buildBaselineAmounts(
  adj: BaselineAdjustmentInput,
  refAt?: Date | null,
): Promise<BaselineAmounts> {
  const [annualRows, totalRows] = await Promise.all([
    prisma.subjectBudget.findMany({
      where: { projectId: adj.projectId, year: adj.year },
      select: { subjectId: true, currentAmount: true },
    }),
    prisma.subjectTotalBudget.findMany({
      where: { projectId: adj.projectId },
      select: { subjectId: true, currentAmount: true },
    }),
  ]);
  const annual = new Map<string, D>(
    annualRows.map((r) => [r.subjectId, fromStored(String(r.currentAmount))]),
  );
  const total = new Map<string, D>(
    totalRows.map((r) => [r.subjectId, fromStored(String(r.currentAmount))]),
  );

  const ownApplied = adj.status === 'APPROVED' && !!adj.approvedAt;
  // 参照时点:显式传入(待审详情用 createdAt)优先;否则已生效单用自身 approvedAt。
  const ref = refAt ?? adj.approvedAt;

  const laterAdjustments =
    ownApplied || ref
      ? await prisma.budgetAdjustment.findMany({
          where: {
            projectId: adj.projectId,
            id: { not: adj.id },
            status: 'APPROVED',
            approvedAt: { gt: ref ?? undefined },
          },
          include: { lines: true },
        })
      : [];

  const relevant: BaselineAdjustmentInput[] = [
    ...(ownApplied ? [adj] : []),
    ...laterAdjustments.map((a) => ({
      id: a.id,
      projectId: a.projectId,
      year: a.year,
      kind: a.kind,
      expandTotals: a.expandTotals,
      status: a.status,
      approvedAt: a.approvedAt,
      lines: a.lines,
    })),
  ];

  const annualDelta = new Map<string, D>();
  const totalDelta = new Map<string, D>();
  for (const a of relevant) {
    for (const line of a.lines) {
      if (!line.subjectId) continue;
      // 年度维度:仅同年行影响该年度基线。
      if (line.year === adj.year) {
        annualDelta.set(
          line.subjectId,
          (annualDelta.get(line.subjectId) ?? fromStored('0')).plus(
            fromStored(String(line.annualAdjustment)),
          ),
        );
      }
      // 总预算维度:调剂 = totalAdjustment;追加下达池内 = 0;expandTotals = 下达额。
      const totalLineDelta =
        a.kind === 'ALLOCATE'
          ? a.expandTotals
            ? fromStored(String(line.annualAdjustment))
            : fromStored('0')
          : fromStored(String(line.totalAdjustment));
      totalDelta.set(
        line.subjectId,
        (totalDelta.get(line.subjectId) ?? fromStored('0')).plus(totalLineDelta),
      );
    }
  }
  for (const [sid, d] of annualDelta) {
    const cur = annual.get(sid);
    if (cur !== undefined) annual.set(sid, cur.minus(d));
  }
  for (const [sid, d] of totalDelta) {
    const cur = total.get(sid);
    if (cur !== undefined) total.set(sid, cur.minus(d));
  }

  return { total, annual };
}
