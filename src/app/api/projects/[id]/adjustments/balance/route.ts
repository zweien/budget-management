import { NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { getAdjustmentBalance } from '@/server/services/adjustment.service';

/**
 * GET /api/projects/:id/adjustments/balance?year=Y — 调整表单余额面板(只读)。
 * 余额锚定口径:总预算 / 全项目累计占用 / 剩余额度 / 目标年计划 / 目标年已占用 / 可新增额度
 * (可新增额度 = 剩余额度 − 目标年剩余计划;服务端提交/审批时另有在途单投影校验)。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const year = Number(new URL(req.url).searchParams.get('year'));
    const balance = await getAdjustmentBalance(id, year, user);
    return NextResponse.json(balance);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
