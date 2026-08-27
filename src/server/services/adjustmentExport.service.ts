import fs from 'node:fs';
import path from 'node:path';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { D, fromStored } from '@/lib/decimal';
import { getAdjustment } from '@/server/services/adjustment.service';
import { fillAdjustmentTemplate } from '@/server/services/docxFill';
import type { User } from '@prisma/client';

/** 导出维度。 */
export type ExportDimension = 'total' | 'annual';

/** 万元换算:元 → 万元字符串(2 位小数)。 */
function toWan(yuan: D): string {
  return yuan.div(10000).toFixed(2);
}

/** 元字符串 → 万元字符串。 */
function yuanStrToWan(s: string): string {
  return toWan(fromStored(s));
}

/** 模板 docx 的 Buffer(进程内缓存)。 */
let templateBufferCache: Buffer | null = null;
function getTemplateBuffer(): Buffer {
  if (!templateBufferCache) {
    const p = path.join(process.cwd(), 'template', '预算调整-template.docx');
    // standalone 部署时 cwd 可能是 .next/standalone,模板已被拷贝进去。
    if (!fs.existsSync(p)) {
      throw new HTTPError(500, `预算调整模板不存在:${p}`);
    }
    templateBufferCache = fs.readFileSync(p);
  }
  return templateBufferCache;
}

/**
 * §导出 预算调整 docx(按模板填充,纯 Node 实现,无子进程)。
 * @param adjId 调整单 id
 * @param dimension 'total'(总预算维度) | 'annual'(年度预算维度)
 * @returns docx 二进制 Buffer
 */
export async function exportAdjustmentDocx(
  adjId: string,
  dimension: ExportDimension,
  user: Pick<User, 'id' | 'role'>,
): Promise<Buffer> {
  // 取调整单(含明细 + 权限校验)。
  const adj = await getAdjustment(adjId, user);
  await requirePermission(user, 'project:view', adj.projectId);

  if (adj.lines.length === 0) {
    throw new HTTPError(422, '该调整单无明细,无法导出');
  }

  const projectId = adj.projectId;
  const year = adj.year;

  const [project, subjects, annualBudgets, totalBudgets, projectBudget, annualBudgetRow] =
    await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        include: { owner: { select: { name: true } } },
      }),
      prisma.budgetSubject.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      prisma.subjectBudget.findMany({
        where: { projectId, year },
        select: { subjectId: true, currentAmount: true },
      }),
      prisma.subjectTotalBudget.findMany({
        where: { projectId },
        select: { subjectId: true, currentAmount: true },
      }),
      prisma.projectBudget.findUnique({ where: { projectId } }),
      prisma.annualBudget.findUnique({ where: { projectId_year: { projectId, year } } }),
    ]);

  if (!project) {
    throw new HTTPError(404, '项目不存在');
  }

  // §issue12 读取兜底:汇总行与科目层漂移时拒绝生成文书,避免带病审批表。
  // 恒等口径:project_budgets.current = Σ 科目总预算;annual_budgets.current = Σ 当年科目年度预算。
  const TOLERANCE = fromStored('0.01'); // 分位容差,吸收历史 Decimal 尾差。
  const stbSum = totalBudgets.reduce(
    (acc, t) => acc.plus(fromStored(t.currentAmount)),
    fromStored('0'),
  );
  if (projectBudget) {
    const pbCurrent = fromStored(projectBudget.currentAmount);
    if (pbCurrent.minus(stbSum).abs().gt(TOLERANCE)) {
      throw new HTTPError(
        422,
        `汇总数据漂移,拒绝导出:项目总预算 current(${pbCurrent.toFixed(2)}) ≠ 科目总预算合计(${stbSum.toFixed(2)})。请先用 scripts/recalc-summary-budgets.ts 修复存量数据。`,
      );
    }
  }
  const sbYearSum = annualBudgets.reduce(
    (acc, s) => acc.plus(fromStored(s.currentAmount)),
    fromStored('0'),
  );
  if (annualBudgetRow) {
    const abCurrent = fromStored(annualBudgetRow.currentAmount);
    if (abCurrent.minus(sbYearSum).abs().gt(TOLERANCE)) {
      throw new HTTPError(
        422,
        `汇总数据漂移,拒绝导出:年度预算(${adj.year}) current(${abCurrent.toFixed(2)}) ≠ 科目年度预算合计(${sbYearSum.toFixed(2)})。请先用 scripts/recalc-summary-budgets.ts 修复存量数据。`,
      );
    }
  }

  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const annualCurrentBySubject = new Map(annualBudgets.map((s) => [s.subjectId, s.currentAmount]));
  const totalCurrentBySubject = new Map(totalBudgets.map((s) => [s.subjectId, s.currentAmount]));

  // 导出"原预算"须为审批前基线:库内 currentAmount 已含本单(若已生效)及所有
  // 更晚生效调整单的 delta。重建 = live − 本单 − 全部更晚生效单(同科目;年度文档
  // 仅扣同年行),否则历史文档的原值/调整后值被后续审批污染。
  if (adj.status === 'APPROVED' && adj.approvedAt) {
    const laterAdjustments = await prisma.budgetAdjustment.findMany({
      where: {
        projectId: adj.projectId,
        id: { not: adj.id },
        status: 'APPROVED',
        approvedAt: { gt: adj.approvedAt },
      },
      include: { lines: true },
    });
    const relevant: {
      kind: string | null;
      expandTotals: boolean;
      lines: {
        subjectId: string | null;
        year: number;
        totalAdjustment: string | Prisma.Decimal;
        annualAdjustment: string | Prisma.Decimal;
      }[];
    }[] = [
      { kind: adj.kind, expandTotals: adj.expandTotals, lines: adj.lines },
      ...laterAdjustments.map((a) => ({
        kind: a.kind,
        expandTotals: a.expandTotals,
        lines: a.lines,
      })),
    ];
    const annualDelta = new Map<string, ReturnType<typeof fromStored>>();
    const totalDelta = new Map<string, ReturnType<typeof fromStored>>();
    for (const a of relevant) {
      for (const line of a.lines) {
        if (!line.subjectId) continue;
        // 年度维度:仅同年行影响该年度文档。
        if (line.year === adj.year) {
          annualDelta.set(
            line.subjectId,
            (annualDelta.get(line.subjectId) ?? fromStored('0')).plus(
              fromStored(line.annualAdjustment),
            ),
          );
        }
        // 总预算维度:调剂 = totalAdjustment;追加下达池内 = 0;expandTotals = 下达额。
        const totalLineDelta =
          a.kind === 'ALLOCATE'
            ? a.expandTotals
              ? fromStored(line.annualAdjustment)
              : fromStored('0')
            : fromStored(line.totalAdjustment);
        totalDelta.set(
          line.subjectId,
          (totalDelta.get(line.subjectId) ?? fromStored('0')).plus(totalLineDelta),
        );
      }
    }
    for (const [sid, d] of annualDelta) {
      const cur = annualCurrentBySubject.get(sid);
      if (cur !== undefined) annualCurrentBySubject.set(sid, fromStored(String(cur)).minus(d));
    }
    for (const [sid, d] of totalDelta) {
      const cur = totalCurrentBySubject.get(sid);
      if (cur !== undefined) totalCurrentBySubject.set(sid, fromStored(String(cur)).minus(d));
    }
  }

  /** 沿 parentId 上溯找二级标题(level<=2)祖先;若自身 level<=2 则自身即标题。 */
  const findSecondLevelTitle = (subjectId: string): { id: string; name: string } | null => {
    let cur = subjectById.get(subjectId);
    if (!cur) return null;
    if (cur.level <= 2) return { id: cur.id, name: cur.name };
    while (cur.parentId) {
      const parent = subjectById.get(cur.parentId);
      if (!parent) break;
      if (parent.level <= 2) return { id: parent.id, name: parent.name };
      cur = parent;
    }
    return { id: subjectId, name: subjectById.get(subjectId)?.name ?? '' };
  };

  const hasChildren = (subjectId: string): boolean =>
    subjects.some((s) => s.parentId === subjectId);

  const rows = adj.lines.map((line) => {
    // 新增科目行(subjectId 为空):标题=父节点名,品名=新科目名,原预算=0。
    if (!line.subjectId) {
      const parent = subjectById.get(line.newSubjectParentId ?? '');
      const adjustYuan =
        dimension === 'total'
          ? fromStored(line.totalAdjustment)
          : fromStored(line.annualAdjustment);
      const adjustWan = toWan(adjustYuan);
      return {
        subjectTitle: parent?.name ?? '',
        productName: line.newSubjectName ?? '',
        originWan: '0.00',
        adjustedWan: adjustWan,
        adjustWan,
      };
    }
    const leaf = subjectById.get(line.subjectId);
    const title = findSecondLevelTitle(line.subjectId);
    const titleHasChildren = title ? hasChildren(title.id) : false;
    const productName = titleHasChildren ? (leaf?.name ?? '') : '';

    const originYuanRaw =
      dimension === 'total'
        ? (totalCurrentBySubject.get(line.subjectId) ?? fromStored('0'))
        : (annualCurrentBySubject.get(line.subjectId) ?? fromStored('0'));
    const originYuan =
      originYuanRaw instanceof D ? originYuanRaw : fromStored(String(originYuanRaw));
    const originWan = toWan(originYuan);

    const adjustYuan =
      dimension === 'total' ? fromStored(line.totalAdjustment) : fromStored(line.annualAdjustment);
    const adjustWan = toWan(adjustYuan);
    const adjustedWan = fromStored(originWan).plus(fromStored(adjustWan)).toFixed(2);

    return {
      subjectTitle: title?.name ?? '',
      productName,
      originWan,
      adjustedWan,
      adjustWan,
    };
  });

  // 合计行:各行金额已是万元字符串,直接累加(不要再 toWan,否则会再除一次 10000)。
  const sumWan = (sel: 'originWan' | 'adjustedWan' | 'adjustWan') =>
    rows.reduce((acc, r) => acc.plus(fromStored(r[sel])), fromStored('0')).toFixed(2);
  const totalOriginWan = sumWan('originWan');
  const totalAdjustedWan = sumWan('adjustedWan');
  const totalAdjustWan = sumWan('adjustWan');

  const researchPeriod =
    project.startDate && project.endDate
      ? `${project.startDate.getFullYear()}.${String(project.startDate.getMonth() + 1).padStart(2, '0')}-${project.endDate.getFullYear()}.${String(project.endDate.getMonth() + 1).padStart(2, '0')}`
      : '';

  // 调用纯 Node 模板填充(无子进程)。
  try {
    return await fillAdjustmentTemplate({
      templateBuffer: getTemplateBuffer(),
      title: dimension === 'total' ? '总预算调整表' : '年度预算调整表',
      project: {
        name: project.name,
        projectType: project.projectType ?? '',
        undertakingUnit: project.undertakingUnit ?? '',
        ownerName: project.owner?.name ?? '',
        researchPeriod,
        totalFundWan: projectBudget ? yuanStrToWan(projectBudget.currentAmount.toString()) : '0.00',
        annualFundWan: annualBudgetRow
          ? yuanStrToWan(annualBudgetRow.currentAmount.toString())
          : '0.00',
      },
      reason: (dimension === 'total' ? adj.totalReason : adj.annualReason) ?? '',
      rows,
      totalOriginWan,
      totalAdjustedWan,
      totalAdjustWan,
    });
  } catch (e) {
    console.error('docx 生成失败:', e instanceof Error ? e.message : e);
    throw new HTTPError(500, '生成预算调整文档失败');
  }
}
