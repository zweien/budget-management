import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/prisma';
import { fromStored } from '@/lib/decimal';

/**
 * GET /api/projects/:id/adjustments/baseline?year=Y
 * 返回该项目某年度所有叶科目的「预算基线」(供调整表单回填原值):
 *  - totalCurrent: 科目总预算当前值(SubjectTotalBudget.currentAmount)
 *  - annualCurrent: 科目年度预算当前值(SubjectBudget[year].currentAmount)
 *  - remaining:    剩余可分配额 = 总预算 − 历年已分配 SubjectBudget 合计
 *                  (追加下达模式的每行上限;跨年概念,不随 query.year 变化)
 *
 * 调整表单据此显示「原总预算 / 原年度预算」只读列并联动计算调整后值;
 * 追加模式用 remaining 实时校验下达额。
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requirePermission(user, 'project:view', projectId);

    const url = new URL(_req.url);
    const year = Number(url.searchParams.get('year'));
    if (!Number.isInteger(year) || year < 1900 || year > 9999) {
      throw new HTTPError(422, 'year 必须是 1900~9999 的正整数');
    }

    const subjects = await prisma.budgetSubject.findMany({
      where: { projectId, isLeaf: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true },
    });

    // 年度基线筛指定年份;剩余可分配额需要历年全部。
    const [annualBudgets, yearlyAllocations, totalBudgets] = await Promise.all([
      prisma.subjectBudget.findMany({
        where: { projectId, year },
        select: { subjectId: true, currentAmount: true },
      }),
      prisma.subjectBudget.findMany({
        where: { projectId },
        select: { subjectId: true, currentAmount: true },
      }),
      prisma.subjectTotalBudget.findMany({
        where: { projectId },
        select: { subjectId: true, currentAmount: true },
      }),
    ]);

    const annualMap = new Map(annualBudgets.map((s) => [s.subjectId, s.currentAmount]));
    const totalMap = new Map(totalBudgets.map((s) => [s.subjectId, s.currentAmount]));

    // 历年已分配合计(Decimal 字符串求和走 Number 足够——展示用;服务端提交时还有精确校验兜底)。
    const allocatedSumBySubject = new Map<string, number>();
    for (const a of yearlyAllocations) {
      allocatedSumBySubject.set(
        a.subjectId,
        (allocatedSumBySubject.get(a.subjectId) ?? 0) + Number(fromStored(a.currentAmount)),
      );
    }

    const baseline = subjects.map((s) => {
      const totalCurrent = fromStored(totalMap.get(s.id) ?? 0);
      const allocatedSum = allocatedSumBySubject.get(s.id) ?? 0;
      return {
        subjectId: s.id,
        code: s.code,
        name: s.name,
        totalCurrent: totalCurrent.toFixed(2),
        annualCurrent: fromStored(annualMap.get(s.id) ?? 0).toFixed(2),
        remaining: Math.max(0, Number(totalCurrent) - allocatedSum).toFixed(2),
      };
    });

    return NextResponse.json({ year, baseline });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
