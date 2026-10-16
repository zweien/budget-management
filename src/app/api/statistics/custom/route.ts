import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { parseRecordFilters } from '@/lib/api/record-filters';
import { customStatistics } from '@/server/services/statistics.service';

/** 自定义统计与分页明细，筛选全集合计由服务端计算。 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  const filters = parseRecordFilters(req.nextUrl.searchParams);
  const result = await customStatistics(filters, user);
  return NextResponse.json(result);
});
