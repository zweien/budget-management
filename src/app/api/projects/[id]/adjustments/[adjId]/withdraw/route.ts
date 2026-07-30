import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { withdrawAdjustment } from '@/server/services/adjustment.service';

/**
 * POST /api/projects/:id/adjustments/:adjId/withdraw — 撤回调整单(PENDING→DRAFT,释放锁)。
 * 申请人发起,无 body。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;
    const adjustment = await withdrawAdjustment(adjId, user);
    return NextResponse.json({ adjustment });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
