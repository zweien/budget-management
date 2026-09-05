import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  createDraft,
  getDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';

/** GET /api/projects/:id/initial-budget — 取该项目编制草稿(含科目树/预算,供回填)。 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const draft = await getDraft(id, user);
    return NextResponse.json(draft);
  },
);

/** POST /api/projects/:id/initial-budget — 创建编制草稿(body = InitialBudgetPayload)。 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as InitialBudgetPayload;
    const { appId } = await createDraft(id, body, user);
    return NextResponse.json({ appId }, { status: 201 });
  },
);
