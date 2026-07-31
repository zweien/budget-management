import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  deleteDraftAdjustment,
  getAdjustment,
  updateDraftAdjustment,
  type AdjustmentPayload,
} from '@/server/services/adjustment.service';

/** GET /api/projects/:id/adjustments/:adjId — 取单个调整单(含明细 + 锁)。 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;
    const adjustment = await getAdjustment(adjId, user);
    return NextResponse.json({ adjustment });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/** PATCH /api/projects/:id/adjustments/:adjId — 编辑调整草稿(仅 DRAFT)。 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;
    const body = (await req.json()) as AdjustmentPayload;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const adjustment = await updateDraftAdjustment(adjId, body, user);
    return NextResponse.json({ adjustment });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/** DELETE /api/projects/:id/adjustments/:adjId — 删除调整草稿(仅 DRAFT)。 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;
    await deleteDraftAdjustment(adjId, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
