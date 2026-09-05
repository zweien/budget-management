import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { getProjectTotalLedger } from '@/server/services/ledger.service';

/**
 * GET /api/projects/:id/ledger-total — 总预算执行台账(跨年度口径)。
 * 预算 = 科目总预算(包干制回退 Σ 各年度科目预算),占用 = 全部年度非作废业务记录;
 * 结余 = 总预算·当前 − 总占用;执行率 = 总占用 ÷ 总预算·当前。
 */
export const GET = withRoute(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const ledger = await getProjectTotalLedger(id, user);
    return NextResponse.json(ledger);
  },
);
