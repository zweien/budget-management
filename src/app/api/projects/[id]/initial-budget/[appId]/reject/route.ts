import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { rejectApplication } from '@/server/services/initialBudget.service';

/**
 * POST /api/projects/:id/initial-budget/:appId/reject — 驳回(PENDING→REJECTED)。
 * body { opinion }。仅 BUDGET_ADMIN 有 budget:approve 权限。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; appId: string }> },
) {
  try {
    const user = await requireUser();
    const { appId } = await params;
    let opinion = '';
    try {
      const body = await req.json();
      opinion = typeof body?.opinion === 'string' ? body.opinion : '';
    } catch {
      // body 缺失时默认空意见。
    }
    const result = await rejectApplication(appId, user, opinion);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
