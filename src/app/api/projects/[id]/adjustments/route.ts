import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  createAdjustment,
  listAdjustments,
  type AdjustmentPayload,
} from '@/server/services/adjustment.service';

/**
 * GET /api/projects/:id/adjustments — 列出调整单(含明细 + 锁)。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const adjustments = await listAdjustments(id, user);
    return NextResponse.json({ adjustments });
  },
);

/**
 * POST /api/projects/:id/adjustments — 创建调整草稿(§7)。
 * body = AdjustmentPayload:{ type, reason?, lines[] }。
 * 返回创建的 BudgetAdjustment(含 id)。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as AdjustmentPayload;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const adjustment = await createAdjustment(id, body, user);
    return NextResponse.json({ adjustment }, { status: 201 });
  },
);
