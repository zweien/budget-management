import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { withdrawApplication } from '@/server/services/initialBudget.service';

/**
 * POST /api/projects/:id/initial-budget/:appId/withdraw — 撤回(PENDING→DRAFT)。
 * §6.2 已撤回 → 草稿(修改),由申请人发起,无 body。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; appId: string }> },
) {
  try {
    const user = await requireUser();
    const { appId } = await params;
    const result = await withdrawApplication(appId, user);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
