import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { rejectAdjustment } from '@/server/services/adjustment.service';

/**
 * POST /api/projects/:id/adjustments/:adjId/reject — 驳回调整单(释放锁,PENDING→REJECTED)。
 * body = { opinion: string }(驳回意见,必填)。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;

    let opinion = '';
    try {
      const body = (await req.json()) as { opinion?: unknown };
      if (body && typeof body.opinion === 'string') {
        opinion = body.opinion;
      }
    } catch {
      // body 解析失败视为空意见。
    }

    const adjustment = await rejectAdjustment(adjId, user, opinion);
    return NextResponse.json({ adjustment });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
