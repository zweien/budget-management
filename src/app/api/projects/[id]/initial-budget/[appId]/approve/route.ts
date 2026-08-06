import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { approveApplication } from '@/server/services/initialBudget.service';

/**
 * POST /api/projects/:id/initial-budget/:appId/approve — 审批生效(§6.3 整体生效)。
 * body 可选 { opinion }。仅 ADMIN 有 budget:approve 权限。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; appId: string }> },
) {
  try {
    const user = await requireUser();
    const { appId } = await params;
    let opinion: string | undefined;
    try {
      const body = await req.json();
      opinion = typeof body?.opinion === 'string' ? body.opinion : undefined;
    } catch {
      // body 可空,容错忽略。
    }
    const result = await approveApplication(appId, user, opinion);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
