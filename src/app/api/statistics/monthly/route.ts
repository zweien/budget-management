import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { monthlyHistory } from '@/server/services/statistics.service';

/**
 * GET /api/statistics/monthly?projectId=&year= — 月度历史统计(§11.4)。
 * 必传 projectId、year。返回 { months: [{month:1..12, paid, payable, totalOccupied}] }。
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;

  const projectId = sp.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: '缺少 projectId 参数' }, { status: 400 });
  }
  const yearParam = sp.get('year');
  if (!yearParam) {
    return NextResponse.json({ error: '缺少 year 参数' }, { status: 400 });
  }
  const year = Number.parseInt(yearParam, 10);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
  }

  const result = await monthlyHistory(projectId, year, user);
  return NextResponse.json(result);
});
