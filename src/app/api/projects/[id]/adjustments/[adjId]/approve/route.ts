import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { approveAdjustment } from '@/server/services/adjustment.service';

/**
 * POST /api/projects/:id/adjustments/:adjId/approve — 审批通过调整单(§7.6 生效事务)。
 * body = { opinion?: string }(可选审批意见)。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;

    let opinion: string | undefined;
    try {
      const body = (await req.json()) as { opinion?: unknown };
      if (body && typeof body.opinion === 'string') {
        opinion = body.opinion;
      }
    } catch {
      // body 可空;无 opinion 即可。
    }

    const adjustment = await approveAdjustment(adjId, user, opinion);
    return NextResponse.json({ adjustment });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
