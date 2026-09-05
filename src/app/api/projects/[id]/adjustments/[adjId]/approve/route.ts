import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { approveAdjustment } from '@/server/services/adjustment.service';

/**
 * POST /api/projects/:id/adjustments/:adjId/approve — 审批通过调整单(§7.6 生效事务)。
 * body = { opinion?: string }(可选审批意见)。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; adjId: string }> }) => {
    const user = await requireUser();
    const { adjId } = await params;

    let opinion: string | undefined;
    let submittedAt: string | undefined;
    try {
      const body = (await req.json()) as { opinion?: unknown; submittedAt?: unknown };
      if (body && typeof body.opinion === 'string') {
        opinion = body.opinion;
      }
      // 审批人所见版本的提交代(§版本绑定):与锁内单据不一致 → 409。
      if (body && typeof body.submittedAt === 'string') {
        submittedAt = body.submittedAt;
      }
    } catch {
      // body 可空;无 opinion 即可。
    }

    const adjustment = await approveAdjustment(adjId, user, opinion, submittedAt);
    return NextResponse.json({ adjustment });
  },
);
