import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/prisma';
import { fromStored } from '@/lib/decimal';

/**
 * GET /api/projects/:id/adjustments/baseline?year=Y
 * 返回该项目某年度所有叶科目的「预算基线」(供调整表单回填原值):
 *  - totalCurrent: 科目总预算当前值(SubjectTotalBudget.currentAmount)
 *  - annualCurrent: 科目年度预算当前值(SubjectBudget.currentAmount)
 *
 * 调整表单据此显示「原总预算 / 原年度预算」只读列,并联动计算调整后值。
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

    const [annualBudgets, totalBudgets] = await Promise.all([
      prisma.subjectBudget.findMany({
        where: { projectId, year },
        select: { subjectId: true, currentAmount: true },
      }),
      prisma.subjectTotalBudget.findMany({
        where: { projectId },
        select: { subjectId: true, currentAmount: true },
      }),
    ]);

    const annualMap = new Map(annualBudgets.map((s) => [s.subjectId, s.currentAmount]));
    const totalMap = new Map(totalBudgets.map((s) => [s.subjectId, s.currentAmount]));

    const baseline = subjects.map((s) => ({
      subjectId: s.id,
      code: s.code,
      name: s.name,
      totalCurrent: fromStored(totalMap.get(s.id) ?? 0).toFixed(2),
      annualCurrent: fromStored(annualMap.get(s.id) ?? 0).toFixed(2),
    }));

    return NextResponse.json({ year, baseline });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
