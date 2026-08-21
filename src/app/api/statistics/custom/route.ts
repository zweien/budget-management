import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  customStatistics,
  type CustomStatisticsFilters,
} from '@/server/services/statistics.service';

const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/**
 * GET /api/statistics/custom — 自定义统计(§11.3)。
 * Query 参数即筛选条件:
 *   projectId, budgetYear, subject(科目名称/编号模糊),
 *   status, businessDateFrom, businessDateTo, handler, includeVoid(0/1)。
 * 返回 { summary, records }。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const sp = req.nextUrl.searchParams;

    const filters: CustomStatisticsFilters = {};
    const projectId = sp.get('projectId');
    if (projectId) filters.projectId = projectId;

    const yearParam = sp.get('budgetYear');
    if (yearParam !== null) {
      const year = Number.parseInt(yearParam, 10);
      if (!Number.isInteger(year) || year < 1900 || year > 9999) {
        return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
      }
      filters.budgetYear = year;
    }

    const subject = sp.get('subject');
    if (subject) filters.subject = subject;

    const status = sp.get('status');
    if (status) {
      if (!STATUS_SET.has(status)) {
        return NextResponse.json({ error: `状态参数无效:${status}` }, { status: 400 });
      }
      filters.status = status as BusinessStatus;
    }

    const businessDateFrom = sp.get('businessDateFrom');
    if (businessDateFrom) filters.businessDateFrom = businessDateFrom;
    const businessDateTo = sp.get('businessDateTo');
    if (businessDateTo) filters.businessDateTo = businessDateTo;

    const handler = sp.get('handler');
    if (handler) filters.handler = handler;

    const includeVoidParam = sp.get('includeVoid');
    if (includeVoidParam === '1' || includeVoidParam === 'true') {
      filters.includeVoid = true;
    }

    const result = await customStatistics(filters, user);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
