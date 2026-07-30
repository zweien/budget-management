import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { getAdjustment } from '@/server/services/adjustment.service';

/** GET /api/projects/:id/adjustments/:adjId — 取单个调整单(含明细 + 锁)。 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;
    const adjustment = await getAdjustment(adjId, user);
    return NextResponse.json({ adjustment });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
