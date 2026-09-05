import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { submitDraft } from '@/server/services/initialBudget.service';

/** POST /api/projects/:id/initial-budget/:appId/submit — 提交编制单(DRAFT→PENDING)。 */
export const POST = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; appId: string }> }) => {
    const user = await requireUser();
    const { appId } = await params;
    const result = await submitDraft(appId, user);
    return NextResponse.json(result);
  },
);
