import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  crossProjectStatistics,
  type CrossProjectStatisticsFilters,
} from '@/server/services/statistics.service';

/**
 * GET /api/statistics/cross-project — 跨项目统计(§11.5)。
 * 所有登录用户可用(全局只读,§2.2 v0.3.0)。
 * 可选 query: year(占用按年度过滤)。
 * 返回 { projects: [{projectId, name, currentBudget, totalOccupied, paid, balance, executionRate}] }。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const sp = req.nextUrl.searchParams;

    const filters: CrossProjectStatisticsFilters = {};
    const yearParam = sp.get('year');
    if (yearParam !== null) {
      const year = Number.parseInt(yearParam, 10);
      if (!Number.isInteger(year) || year < 1900 || year > 9999) {
        return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
      }
      filters.year = year;
    }

    const result = await crossProjectStatistics(filters, user);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
