import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { withdrawApplication } from '@/server/services/initialBudget.service';

/**
 * POST /api/projects/:id/initial-budget/:appId/withdraw — 撤回(PENDING→DRAFT)。
 * §6.2 已撤回 → 草稿(修改),由申请人发起,无 body。
 */
export const POST = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; appId: string }> }) => {
    const user = await requireUser();
    const { appId } = await params;
    const result = await withdrawApplication(appId, user);
    return NextResponse.json(result);
  },
);
