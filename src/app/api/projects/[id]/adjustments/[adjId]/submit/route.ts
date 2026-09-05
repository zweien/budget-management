import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { submitAdjustment } from '@/server/services/adjustment.service';

/** POST /api/projects/:id/adjustments/:adjId/submit — 提交调整单(DRAFT→PENDING,落 §7.4/7.5 锁)。 */
export const POST = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; adjId: string }> }) => {
    const user = await requireUser();
    const { adjId } = await params;
    const adjustment = await submitAdjustment(adjId, user);
    return NextResponse.json({ adjustment });
  },
);
