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
 *  - remaining:    科目本年剩余额度(余额锚定)= 科目总预算剩余(总预算 − 累计占用)
 *                  − 本年剩余计划(年度计划 − 该年已占用);追加下达模式的每行参考上限
 *
 * 调整表单据此显示「原总预算 / 原年度预算」只读列并联动计算调整后值;
 * 追加模式用 remaining 实时预检下达额(服务端提交/审批时精确复核)。
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

    // 年度基线筛指定年份;剩余额度需要历年计划 + 累计占用(全部年度非作废记录)。
    const [annualBudgets, totalBudgets, cumOccBySubject, yearOccBySubject] = await Promise.all([
      prisma.subjectBudget.findMany({
        where: { projectId, year },
        select: { subjectId: true, currentAmount: true },
      }),
      prisma.subjectTotalBudget.findMany({
        where: { projectId },
        select: { subjectId: true, currentAmount: true },
      }),
      prisma.businessRecord.groupBy({
        by: ['subjectId'],
        where: { projectId, isVoid: false },
        _sum: { amount: true },
      }),
      prisma.businessRecord.groupBy({
        by: ['subjectId'],
        where: { projectId, budgetYear: year, isVoid: false },
        _sum: { amount: true },
      }),
    ]);

    const annualMap = new Map(annualBudgets.map((s) => [s.subjectId, s.currentAmount]));
    const totalMap = new Map(totalBudgets.map((s) => [s.subjectId, s.currentAmount]));
    // 非作废记录全额为占用(paid + payable = 全部);Number 求和仅展示用,服务端提交时精确复核。
    const cumOccMap = new Map(
      cumOccBySubject.map((g) => [g.subjectId, Number(fromStored(String(g._sum.amount ?? '0')))]),
    );
    const yearOccMap = new Map(
      yearOccBySubject.map((g) => [g.subjectId, Number(fromStored(String(g._sum.amount ?? '0')))]),
    );

    const baseline = subjects.map((s) => {
      const totalCurrent = fromStored(totalMap.get(s.id) ?? 0);
      const annualCurrent = fromStored(annualMap.get(s.id) ?? 0);
      const stbRemaining = Number(totalCurrent) - (cumOccMap.get(s.id) ?? 0);
      const yearRemainingPlan = Number(annualCurrent) - (yearOccMap.get(s.id) ?? 0);
      return {
        subjectId: s.id,
        code: s.code,
        name: s.name,
        totalCurrent: totalCurrent.toFixed(2),
        annualCurrent: annualCurrent.toFixed(2),
        remaining: (stbRemaining - yearRemainingPlan).toFixed(2),
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
