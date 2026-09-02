import { prisma } from '@/lib/prisma';

/**
 * 科目映射记忆:项目内「摘要 → 科目」的历史确认统计(来自未作废业务记录)。
 * 供 coding agent 在结算单导入时自动指派科目;未命中的由 agent 语义判断,
 * 仍不确定则将批次留在暂存并汇报待指派(见 AGENTS.md「确认策略」)。
 */

export interface SubjectMapping {
  /** 归一化后的摘要。 */
  summary: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  /** 该摘要→科目组合的历史使用次数。 */
  useCount: number;
  lastUsedAt: Date;
}

export interface SubjectMappingOptions {
  /** 摘要包含匹配(不区分大小写);缺省返回全部。 */
  q?: string;
  /** 返回条数上限(默认 200,上限 500)。 */
  limit?: number;
}

/** 摘要归一化:去首尾空白、压缩连续空白(与导入行摘要的常见差异对齐)。 */
export function normalizeSummary(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * 返回按使用次数降序(并列取最近使用)的映射列表。
 * 同一归一化摘要命中多个科目时,保留使用次数最多者——次选由 agent 结合科目树自行判断。
 */
export async function getSubjectMappings(
  projectId: string,
  options: SubjectMappingOptions = {},
): Promise<SubjectMapping[]> {
  const groups = await prisma.businessRecord.groupBy({
    by: ['summary', 'subjectId'],
    where: { projectId, isVoid: false },
    _count: { _all: true },
    _max: { createdAt: true },
  });

  interface Acc {
    subjectId: string;
    useCount: number;
    lastUsedAt: Date;
  }
  // 归一化摘要 → 科目 → 累计(原始摘要写法差异在此合并)。
  const merged = new Map<string, Map<string, Acc>>();
  const needle = options.q?.trim().toLowerCase();
  for (const g of groups) {
    const key = normalizeSummary(g.summary);
    if (!key) continue;
    if (needle && !key.toLowerCase().includes(needle)) continue;
    const bySubject = merged.get(key) ?? new Map<string, Acc>();
    const prev = bySubject.get(g.subjectId);
    if (prev) {
      prev.useCount += g._count._all;
      if (g._max.createdAt && g._max.createdAt > prev.lastUsedAt) {
        prev.lastUsedAt = g._max.createdAt;
      }
    } else {
      bySubject.set(g.subjectId, {
        subjectId: g.subjectId,
        useCount: g._count._all,
        lastUsedAt: g._max.createdAt ?? new Date(0),
      });
    }
    merged.set(key, bySubject);
  }

  // 每个摘要取使用次数最多的科目,再按使用次数/最近使用整体排序。
  const rows = [...merged.entries()].flatMap(([summary, bySubject]) => {
    const best = [...bySubject.values()].sort(
      (a, b) => b.useCount - a.useCount || b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
    )[0];
    return [{ summary, ...best }];
  });
  rows.sort((a, b) => b.useCount - a.useCount || b.lastUsedAt.getTime() - a.lastUsedAt.getTime());

  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const top = rows.slice(0, limit);

  const subjects = await prisma.budgetSubject.findMany({
    where: { id: { in: [...new Set(top.map((r) => r.subjectId))] } },
    select: { id: true, code: true, name: true },
  });
  const smap = new Map(subjects.map((s) => [s.id, s]));

  return top.map((r) => ({
    summary: r.summary,
    subjectId: r.subjectId,
    subjectCode: smap.get(r.subjectId)?.code ?? '',
    subjectName: smap.get(r.subjectId)?.name ?? '',
    useCount: r.useCount,
    lastUsedAt: r.lastUsedAt,
  }));
}
