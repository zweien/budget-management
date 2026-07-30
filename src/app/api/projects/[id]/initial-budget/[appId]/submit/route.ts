import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { submitDraft } from '@/server/services/initialBudget.service';

/** POST /api/projects/:id/initial-budget/:appId/submit — 提交编制单(DRAFT→PENDING)。 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; appId: string }> },
) {
  try {
    const user = await requireUser();
    const { appId } = await params;
    const result = await submitDraft(appId, user);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
