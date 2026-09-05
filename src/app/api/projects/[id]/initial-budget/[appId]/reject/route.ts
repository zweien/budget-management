import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { rejectApplication } from '@/server/services/initialBudget.service';

/**
 * POST /api/projects/:id/initial-budget/:appId/reject — 驳回(PENDING→REJECTED)。
 * body { opinion }。仅 ADMIN 有 budget:approve 权限。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; appId: string }> }) => {
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
  },
);
