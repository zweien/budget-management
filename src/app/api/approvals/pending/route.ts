import { NextResponse } from 'next/server';

import { ApprovalStatus, UserRole } from '@prisma/client';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/approvals/pending — 审批中心聚合待办(admin-only)。
 *
 * 跨项目汇总三类待审批单据:
 * - initialBudgets: InitialBudgetApplication status=PENDING(附带 project + applicant 信息)
 * - adjustments: BudgetAdjustment status=PENDING(applicant 名通过单独查询拼回,
 *   因 BudgetAdjustment 无 applicant 关系,只存 applicantId)
 * - subjectChanges: SubjectChangeApplication status=PENDING
 *
 * 仅 BUDGET_ADMIN 可调用(审批权 budget:approve 仅 admin 拥有,§2.2)。
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (user.role !== UserRole.BUDGET_ADMIN) {
      throw new HTTPError(403, '审批中心仅预算管理员可用');
    }

    const [initialBudgets, adjustments, subjectChanges] = await Promise.all([
      prisma.initialBudgetApplication.findMany({
        where: { status: ApprovalStatus.PENDING },
        include: {
          project: { select: { id: true, code: true, name: true } },
          applicant: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: 'asc' },
      }),
      prisma.budgetAdjustment.findMany({
        where: { status: ApprovalStatus.PENDING },
        include: {
          project: { select: { id: true, code: true, name: true } },
          lines: { select: { id: true } },
        },
        orderBy: { updatedAt: 'asc' },
      }),
      prisma.subjectChangeApplication.findMany({
        where: { status: ApprovalStatus.PENDING },
        include: {
          project: { select: { id: true, code: true, name: true } },
          applicant: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: 'asc' },
      }),
    ]);

    // BudgetAdjustment 无 applicant 关系,单独取名字拼回。
    const applicantIds = Array.from(new Set(adjustments.map((a) => a.applicantId)));
    const applicants =
      applicantIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: applicantIds } },
            select: { id: true, name: true },
          })
        : [];
    const applicantMap = new Map(applicants.map((u) => [u.id, u]));

    const adjustmentsWithApplicant = adjustments.map((a) => ({
      id: a.id,
      projectId: a.projectId,
      year: a.year,
      status: a.status,
      totalReason: a.totalReason,
      annualReason: a.annualReason,
      applicantId: a.applicantId,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      project: a.project,
      applicant: applicantMap.get(a.applicantId) ?? { id: a.applicantId, name: '未知用户' },
      lineCount: a.lines.length,
    }));

    return NextResponse.json({
      initialBudgets,
      adjustments: adjustmentsWithApplicant,
      subjectChanges,
    });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
