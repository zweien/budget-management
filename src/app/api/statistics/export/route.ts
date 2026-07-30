import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { exportStatistics } from '@/server/services/export.service';
import type { CustomStatisticsFilters } from '@/server/services/statistics.service';

const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/**
 * GET /api/statistics/export — 导出自定义统计结果 xlsx(§10.5)。
 * Query 参数即筛选条件(同 /api/statistics/custom):
 *   projectId, budgetYear, subjectId, status,
 *   businessDateFrom, businessDateTo, handler, includeVoid(0/1)。
 * 返回 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet。
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

    const subjectId = sp.get('subjectId');
    if (subjectId) filters.subjectId = subjectId;

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

    const buffer = await exportStatistics(filters, user);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="statistics.xlsx"',
      },
    });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
