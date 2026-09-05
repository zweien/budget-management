import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { updateDraft, type InitialBudgetPayload } from '@/server/services/initialBudget.service';

/**
 * PATCH /api/projects/[id]/initial-budget/[appId]
 * 修改编制草稿(§6.2 驳回/撤回后回到草稿,或 DRAFT 直接改)。
 */
export const PATCH = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; appId: string }> }) => {
    const user = await requireUser();
    const { appId } = await params;
    const payload = (await req.json()) as InitialBudgetPayload;
    const result = await updateDraft(appId, payload, user);
    return NextResponse.json(result);
  },
);
