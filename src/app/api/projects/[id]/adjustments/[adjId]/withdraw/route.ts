import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { withdrawAdjustment } from '@/server/services/adjustment.service';

/**
 * POST /api/projects/:id/adjustments/:adjId/withdraw — 撤回调整单(PENDING→DRAFT,释放锁)。
 * 申请人发起,无 body。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; adjId: string }> }) => {
    const user = await requireUser();
    const { adjId } = await params;

    // 操作人所见版本的提交代(§版本绑定),body 可空。
    let submittedAt: string | undefined;
    try {
      const body = (await req.json()) as { submittedAt?: unknown };
      if (body && typeof body.submittedAt === 'string') {
        submittedAt = body.submittedAt;
      }
    } catch {
      // ignore
    }

    const adjustment = await withdrawAdjustment(adjId, user, submittedAt);
    return NextResponse.json({ adjustment });
  },
);
