import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  deleteDraftAdjustment,
  getAdjustment,
  getAdjustmentDetail,
  updateDraftAdjustment,
  type AdjustmentPayload,
} from '@/server/services/adjustment.service';

/**
 * GET /api/projects/:id/adjustments/:adjId — 取单个调整单(含明细 + 锁)。
 * 另带 `detail`:科目行原预算/调整额/调整后金额(§issue15 审批详情,基线重建)。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; adjId: string }> }) => {
    const user = await requireUser();
    const { adjId } = await params;
    const [adjustment, detail] = await Promise.all([
      getAdjustment(adjId, user),
      getAdjustmentDetail(adjId, user),
    ]);
    return NextResponse.json({ adjustment, detail });
  },
);

/** PATCH /api/projects/:id/adjustments/:adjId — 编辑调整草稿(仅 DRAFT)。 */
export const PATCH = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; adjId: string }> }) => {
    const user = await requireUser();
    const { adjId } = await params;
    const body = (await req.json()) as AdjustmentPayload;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const adjustment = await updateDraftAdjustment(adjId, body, user);
    return NextResponse.json({ adjustment });
  },
);

/** DELETE /api/projects/:id/adjustments/:adjId — 删除调整草稿(仅 DRAFT)。 */
export const DELETE = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; adjId: string }> }) => {
    const user = await requireUser();
    const { adjId } = await params;
    await deleteDraftAdjustment(adjId, user);
    return NextResponse.json({ ok: true });
  },
);
