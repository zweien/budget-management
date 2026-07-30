import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { voidRecord } from '@/server/services/businessRecord.service';

/**
 * POST /api/projects/:id/records/:recordId/void — 作废业务记录(§8.6)。
 * body = { reason: string }。置 isVoid=true,占用由 ledger 实时聚合自然解除。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  try {
    const user = await requireUser();
    const { recordId } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: string };

    const record = await voidRecord(recordId, body.reason ?? '', user);
    return NextResponse.json({ record });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
