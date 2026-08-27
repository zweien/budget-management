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

/** 零元常量(合计求和初值)。 */
const ZERO_D = fromStored('0');

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

  // §issue12 读取兜底:汇总行账本自洽校验,防止带病文书。
  // 只校验恒等式 current = initial + adjustment——Σ科目 ≤ 总盘的未分配余额是
  // 编制期合法状态(validatePayload 仅要求 ≤),不做父子等值比较(会误杀合法池)。
  // 历史脏数据(姚雯案:initial/adjustment/current = 50/25/50 万)恰以破恒等式为特征。
  const TOLERANCE = fromStored('0.01'); // 分位容差,吸收历史 Decimal 尾差。
  if (projectBudget) {
    const pbI = fromStored(projectBudget.initialAmount);
    const pbA = fromStored(projectBudget.adjustmentAmount);
    const pbC = fromStored(projectBudget.currentAmount);
    if (pbC.minus(pbI).minus(pbA).abs().gt(TOLERANCE)) {
      throw new HTTPError(
        422,
        `汇总数据漂移,拒绝导出:项目总预算 current(${pbC.toFixed(2)}) ≠ initial(${pbI.toFixed(2)}) + adjustment(${pbA.toFixed(2)})。请用 scripts/recalc-summary-budgets.ts 修复存量数据。`,
      );
    }
  }
  if (annualBudgetRow) {
    const abI = fromStored(annualBudgetRow.initialAmount);
    const abA = fromStored(annualBudgetRow.adjustmentAmount);
    const abC = fromStored(annualBudgetRow.currentAmount);
    if (abC.minus(abI).minus(abA).abs().gt(TOLERANCE)) {
      throw new HTTPError(
        422,
        `汇总数据漂移,拒绝导出:年度预算(${adj.year}) current(${abC.toFixed(2)}) ≠ initial(${abI.toFixed(2)}) + adjustment(${abA.toFixed(2)})。请用 scripts/recalc-summary-budgets.ts 修复存量数据。`,
      );
    }
  }

  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const annualCurrentBySubject = new Map(annualBudgets.map((s) => [s.subjectId, s.currentAmount]));
  const totalCurrentBySubject = new Map(totalBudgets.map((s) => [s.subjectId, s.currentAmount]));

  // §issue16(codex P1)科目目录按审批时点取景:之后他单新增的科目不得出现在
  // 本单的历史文书里(其 live 金额也不得混入基线)。未生效单(草稿/待审预览)
  // 不做裁剪,按当前目录渲染。
  const catalogSubjects =
    adj.status === 'APPROVED' && adj.approvedAt
      ? subjects.filter((s) => s.createdAt <= adj.approvedAt!)
      : subjects;

  // 本单"新设科目"集合:审批时建档的科目(新数据审批回写 subjectId;历史单据按
  // 父节点+名称解析)。其原预算恒为 0——科目因本单而生,此前无账。
  const bornSubjectIds = new Set<string>();
  if (adj.status === 'APPROVED' && adj.approvedAt) {
    for (const line of adj.lines) {
      if (line.subjectId && line.newSubjectName) {
        bornSubjectIds.add(line.subjectId);
        continue;
      }
      if (!line.subjectId && line.newSubjectName) {
        // 历史数据:审批时未回写 subjectId,按(父节点,名称)解析到已建科目。
        // 不加 createdAt 截断:approvedAt 取自事务前时钟,科目 createdAt 是事务内
        // DB 时钟,必然晚于 approvedAt,截断会恰好排除目标科目。
        // (父节点,名称)在同父下唯一(validateNewSubject 保证),匹配安全。
        const born = subjects.find(
          (s) =>
            s.isLeaf && s.parentId === line.newSubjectParentId && s.name === line.newSubjectName,
        );
        if (born) bornSubjectIds.add(born.id);
      }
    }
  }

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
    // 用审批时点目录判断(§issue16):之后新增的子科目不改变历史文书的品名口径;
    // 本单新设科目计入(它们在审批时点已存在,否则唯一子节点会被误判为无子)。
    catalogSubjects.some((s) => s.parentId === subjectId) ||
    [...bornSubjectIds].some((id) => subjectById.get(id)?.parentId === subjectId);

  type AdjLine = (typeof adj.lines)[number];

  /** 单行渲染(总/年度共用);金额单位:元(D)/万元(string)。 */
  const renderRow = (args: {
    subjectId: string | null;
    newSubjectName?: string | null;
    newSubjectParentId?: string | null;
    adjustYuan: D;
  }) => {
    // 新增科目行(subjectId 为空,草稿/待审预览):标题=父节点名,品名=新科目名,原预算=0。
    if (!args.subjectId) {
      const parent = subjectById.get(args.newSubjectParentId ?? '');
      const adjustWan = toWan(args.adjustYuan);
      return {
        subjectTitle: parent?.name ?? '',
        productName: args.newSubjectName ?? '',
        originWan: '0.00',
        adjustedWan: adjustWan,
        adjustWan,
        originYuan: ZERO_D,
        adjustYuan: args.adjustYuan,
      };
    }
    const leaf = subjectById.get(args.subjectId);
    const title = findSecondLevelTitle(args.subjectId);
    const titleHasChildren = title ? hasChildren(title.id) : false;
    const productName = titleHasChildren ? (leaf?.name ?? '') : '';

    // 本单新设科目:原预算恒为 0(无历史文书口径可言)。
    if (bornSubjectIds.has(args.subjectId)) {
      const adjustWan = toWan(args.adjustYuan);
      return {
        subjectTitle: title?.name ?? '',
        productName,
        originWan: '0.00',
        adjustedWan: adjustWan,
        adjustWan,
        originYuan: ZERO_D,
        adjustYuan: args.adjustYuan,
      };
    }

    const originYuanRaw =
      dimension === 'total'
        ? (totalCurrentBySubject.get(args.subjectId) ?? fromStored('0'))
        : (annualCurrentBySubject.get(args.subjectId) ?? fromStored('0'));
    const originYuan =
      originYuanRaw instanceof D ? originYuanRaw : fromStored(String(originYuanRaw));
    const originWan = toWan(originYuan);

    const adjustWan = toWan(args.adjustYuan);
    const adjustedWan = fromStored(originWan).plus(fromStored(adjustWan)).toFixed(2);

    return {
      subjectTitle: title?.name ?? '',
      productName,
      originWan,
      adjustedWan,
      adjustWan,
      originYuan,
      adjustYuan: args.adjustYuan,
    };
  };

  // 本单新设科目行(按明细顺序):新数据审批已回写 subjectId;历史单据按
  // (父节点,名称)解析到 bornSubjectIds。渲染为 原值0/调整额/调整额。
  const bornLineRows = (pickAdjust: (l: AdjLine) => D): ReturnType<typeof renderRow>[] =>
    adj.lines
      .map((line) => {
        let bornId = line.subjectId && bornSubjectIds.has(line.subjectId) ? line.subjectId : null;
        if (!bornId && !line.subjectId && line.newSubjectName && bornSubjectIds.size > 0) {
          const born = [...bornSubjectIds].find((id) => {
            const s = subjectById.get(id);
            return s?.parentId === line.newSubjectParentId && s?.name === line.newSubjectName;
          });
          bornId = born ?? null;
        }
        if (bornId) return renderRow({ subjectId: bornId, adjustYuan: pickAdjust(line) });
        // 未生效单(草稿/待审):新设科目尚未建档 → 按新增行渲染(标题=父节点,原值 0),
        // 否则该行及其金额会从文书中静默消失。
        if (!line.subjectId) {
          return renderRow({
            subjectId: null,
            newSubjectName: line.newSubjectName,
            newSubjectParentId: line.newSubjectParentId,
            adjustYuan: pickAdjust(line),
          });
        }
        return null;
      })
      .filter((r): r is ReturnType<typeof renderRow> => r !== null);

  let rows: ReturnType<typeof renderRow>[];
  if (dimension === 'total') {
    // §issue16 总预算维度:覆盖审批时点目录内的全部叶科目(科目表 sortOrder 顺序),
    // 未调整科目成行为 基线/0.00/基线;本单新设科目按明细顺序追加在末尾(原值 0)。
    const adjustBySubject = new Map<string, D>();
    for (const line of adj.lines) {
      if (!line.subjectId) continue;
      adjustBySubject.set(
        line.subjectId,
        (adjustBySubject.get(line.subjectId) ?? fromStored('0')).plus(
          fromStored(line.totalAdjustment),
        ),
      );
    }
    // 历史单据(未回写 subjectId):把新设科目行的本单 delta 并入其已建科目,
    // 供 bornLineRows 渲染调整额(目录循环不会为其成行,bornSubjectIds 已排除)。
    if (bornSubjectIds.size > 0) {
      for (const line of adj.lines) {
        if (line.subjectId || !line.newSubjectName) continue;
        const born = [...bornSubjectIds].find((id) => {
          const s = subjectById.get(id);
          return s?.parentId === line.newSubjectParentId && s?.name === line.newSubjectName;
        });
        if (born) {
          adjustBySubject.set(
            born,
            (adjustBySubject.get(born) ?? fromStored('0')).plus(fromStored(line.totalAdjustment)),
          );
        }
      }
    }
    rows = [
      ...catalogSubjects
        .filter((s) => s.isLeaf && !bornSubjectIds.has(s.id))
        .map((s) =>
          renderRow({
            subjectId: s.id,
            adjustYuan: adjustBySubject.get(s.id) ?? fromStored('0'),
          }),
        ),
      ...bornLineRows((l) => fromStored(l.totalAdjustment)),
    ];
  } else {
    // 年度维度维持现状:仅调整单明细(getAdjustment 已按 id 稳定排序);
    // 本单新设科目按科目口径渲染(原值 0),其余行原样。
    rows = bornLineRows((l) => fromStored(l.annualAdjustment));
    const bornLineIds = new Set(
      adj.lines
        .filter((l) => (l.subjectId && bornSubjectIds.has(l.subjectId)) || !l.subjectId)
        .map((l) => l.id),
    );
    rows = [
      ...rows,
      ...adj.lines
        .filter((l) => !bornLineIds.has(l.id))
        .map((line) =>
          renderRow({
            subjectId: line.subjectId,
            adjustYuan: fromStored(line.annualAdjustment),
          }),
        ),
    ];
  }

  // 合计行:对原始元值求和后一次转万元(§codex P2——逐行万元取整再累加会在
  // 大量小额科目上放大误差,如 100 行 49 元会合计成 0.00 万)。
  const sumYuan = (sel: 'originYuan' | 'adjustYuan') =>
    rows.reduce((acc, r) => acc.plus(r[sel]), ZERO_D);
  const totalOriginWan = toWan(sumYuan('originYuan'));
  const totalAdjustWan = toWan(sumYuan('adjustYuan'));
  const totalAdjustedWan = toWan(sumYuan('originYuan').plus(sumYuan('adjustYuan')));

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
