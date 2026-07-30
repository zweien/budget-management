import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  createAdjustment,
  listAdjustments,
  type AdjustmentPayload,
} from '@/server/services/adjustment.service';

/**
 * GET /api/projects/:id/adjustments — 列出调整单(含明细 + 锁)。
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const adjustments = await listAdjustments(id, user);
    return NextResponse.json({ adjustments });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/**
 * POST /api/projects/:id/adjustments — 创建调整草稿(§7)。
 * body = AdjustmentPayload:{ type, reason?, lines[] }。
 * 返回创建的 BudgetAdjustment(含 id)。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as AdjustmentPayload;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const adjustment = await createAdjustment(id, body, user);
    return NextResponse.json({ adjustment }, { status: 201 });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
