import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { exportBalanceStatistics, exportStatistics } from '@/server/services/export.service';
import type {
  BalanceStatisticsFilters,
  CustomStatisticsFilters,
} from '@/server/services/statistics.service';

const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/**
 * GET /api/statistics/export — 导出统计结果 xlsx(§10.5)。
 * - mode=balance:经费余额(总预算口径),参数 subject/projectId/year/onlyNegative。
 * - 缺省:自定义统计,参数同 /api/statistics/custom:
 *   projectId, budgetYear, subject, status,
 *   businessDateFrom, businessDateTo, handler, includeVoid(0/1)。
 * 返回 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const sp = req.nextUrl.searchParams;

    if (sp.get('mode') === 'balance') {
      const balanceFilters: BalanceStatisticsFilters = {};
      const subject = sp.get('subject');
      if (subject) balanceFilters.subject = subject;
      const projectId = sp.get('projectId');
      if (projectId) balanceFilters.projectId = projectId;
      const yearParam = sp.get('year');
      if (yearParam !== null) {
        const year = Number.parseInt(yearParam, 10);
        if (!Number.isInteger(year) || year < 1900 || year > 9999) {
          return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
        }
        balanceFilters.year = year;
      }
      const onlyNegative = sp.get('onlyNegative');
      if (onlyNegative === '1' || onlyNegative === 'true') {
        balanceFilters.onlyNegative = true;
      }
      const buffer = await exportBalanceStatistics(balanceFilters, user);
      return new NextResponse(buffer as unknown as BodyInit, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="balance-statistics.xlsx"',
        },
      });
    }

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
