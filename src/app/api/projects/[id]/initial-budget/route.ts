import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  createDraft,
  getDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';

/** GET /api/projects/:id/initial-budget — 取该项目编制草稿(含科目树/预算,供回填)。 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const draft = await getDraft(id, user);
    return NextResponse.json(draft);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/** POST /api/projects/:id/initial-budget — 创建编制草稿(body = InitialBudgetPayload)。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as InitialBudgetPayload;
    const { appId } = await createDraft(id, body, user);
    return NextResponse.json({ appId }, { status: 201 });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
