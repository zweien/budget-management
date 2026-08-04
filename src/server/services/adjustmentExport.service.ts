import fs from 'node:fs';
import path from 'node:path';

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

  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const annualCurrentBySubject = new Map(annualBudgets.map((s) => [s.subjectId, s.currentAmount]));
  const totalCurrentBySubject = new Map(totalBudgets.map((s) => [s.subjectId, s.currentAmount]));

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
      reason: adj.reason ?? '',
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
