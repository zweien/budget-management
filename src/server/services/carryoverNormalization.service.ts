import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * §余额锚定(0.14)遗留结转副本归一化。
 *
 * 旧「跨年结转」(已于 0.14 移除)会把未付记录**复制**到目标年并保留原记录,
 * 两条非作废记录同额并存。占用按记录聚合,成对并存会把一笔义务算成两笔,
 * 虚增全项目/科目累计占用,错挡年度下达(余额锚定容量护栏)与执行预警。
 *
 * 归一化规则:副本(remark 以「[结转自」开头、且有 carryover_in 留痕)在其
 * **源记录仍非作废**时从占用聚合中排除;源已作废/删除则副本单独计数——
 * 任一腿作废后剩余一条照常计数,覆盖全部生命周期。
 *
 * 返回应从占用聚合中排除的记录 id(空数组 = 无需过滤)。
 * 结转副本的跨年双计只影响累计口径;单年度单科目桶内只有一腿,无需处理。
 */
export async function carryoverExcludedRecordIds(
  projectId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string[]> {
  const copies = await tx.businessRecord.findMany({
    where: { projectId, isVoid: false, remark: { startsWith: '[结转自' } },
    select: { id: true },
  });
  if (copies.length === 0) return [];

  // carryover_in 留痕的 reason 精确记录了源记录 id(旧 yearCarryover.service 写入)。
  const inRows = await tx.businessRecordHistory.findMany({
    where: {
      businessRecordId: { in: copies.map((c) => c.id) },
      action: 'carryover_in',
    },
    select: { businessRecordId: true, reason: true },
  });
  const sourceIds = new Set<string>();
  const copyToSource = new Map<string, string>();
  for (const row of inRows) {
    const m = /结转自 \d{4} 年记录 ([0-9a-f-]{36})/.exec(row.reason ?? '');
    if (m) {
      copyToSource.set(row.businessRecordId, m[1]);
      sourceIds.add(m[1]);
    }
  }
  if (sourceIds.size === 0) return [];

  const aliveSources = await tx.businessRecord.findMany({
    where: { id: { in: [...sourceIds] }, projectId, isVoid: false },
    select: { id: true },
  });
  const alive = new Set(aliveSources.map((s) => s.id));
  return [...copyToSource.entries()].filter(([, src]) => alive.has(src)).map(([copyId]) => copyId);
}

/** 生成排除遗留结转副本后的记录 where 片段(exclude 为空时不加过滤)。 */
export function withoutCarryoverExcluded(
  base: Record<string, unknown>,
  exclude: string[],
): Record<string, unknown> {
  return exclude.length > 0 ? { ...base, id: { notIn: exclude } } : base;
}
