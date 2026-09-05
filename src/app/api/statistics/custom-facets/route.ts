import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { customStatisticsFacets } from '@/server/services/statistics.service';

/**
 * GET /api/statistics/custom-facets?projectIds=… — 全局录入页值列筛选候选。
 * 返回 { years, handlerNames, creatorNames, subjectNames }(全量稳定候选,
 * 不随分页页内数据漂移);projectIds 缺省 = 全部项目。全局只读。
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  const projectIds = req.nextUrl.searchParams.getAll('projectIds').filter(Boolean);
  const result = await customStatisticsFacets(projectIds.length ? projectIds : null, user);
  return NextResponse.json(result);
});
