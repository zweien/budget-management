import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  balanceStatistics,
  type BalanceStatisticsFilters,
} from '@/server/services/statistics.service';

/**
 * GET /api/statistics/balance — 经费余额统计(总预算口径)。
 * Query 参数:
 *   subject(科目名称/编号模糊,空=全部叶科目), projectId(可选),
 *   year(可选,选定后行内追加年度口径), onlyNegative(0/1,仅看总结余<0)。
 * 返回 { hitProjects, hitSubjects, rows, total }。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const sp = req.nextUrl.searchParams;

    const filters: BalanceStatisticsFilters = {};
    const subject = sp.get('subject');
    if (subject) filters.subject = subject;

    const projectId = sp.get('projectId');
    if (projectId) filters.projectId = projectId;

    const yearParam = sp.get('year');
    if (yearParam !== null) {
      const year = Number.parseInt(yearParam, 10);
      if (!Number.isInteger(year) || year < 1900 || year > 9999) {
        return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
      }
      filters.year = year;
    }

    const onlyNegative = sp.get('onlyNegative');
    if (onlyNegative === '1' || onlyNegative === 'true') {
      filters.onlyNegative = true;
    }

    const result = await balanceStatistics(filters, user);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
