import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { parseRecordFilters } from '@/lib/api/record-filters';
import { requireUser } from '@/lib/auth/session';
import { exportBalanceStatistics, exportStatistics } from '@/server/services/export.service';
import type { BalanceStatisticsFilters } from '@/server/services/statistics.service';

/**
 * GET /api/statistics/export — 导出统计结果 xlsx(§10.5)。
 * - mode=balance:经费余额(总预算口径),参数 subject/projectId/year/onlyNegative。
 * - 缺省:自定义统计,参数同 /api/statistics/custom:
 *   projectId, budgetYear, subject, status,
 *   businessDateFrom, businessDateTo, handler, includeVoid(0/1)。
 * 返回 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet。
 */
export const GET = withRoute(async (req: NextRequest) => {
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
        // 私有财务数据下载,禁止任何缓存层/浏览器磁盘缓存保留(与其他下载路由一致)。
        'Cache-Control': 'no-store',
      },
    });
  }

  const filters = parseRecordFilters(sp);
  // 导出始终覆盖筛选全集，不接受列表页码截断导出。
  delete filters.page;
  delete filters.pageSize;

  // 用户时区偏移(浏览器 Date#getTimezoneOffset 分钟,UTC+8 = -480):
  // 导出的「录入时间」按用户时区渲染,与页面显示一致(codex P2);非法值忽略,回落服务器时区。
  const tzParam = sp.get('tzOffset');
  const tzOffset = tzParam === null ? NaN : Number(tzParam);
  const enteredAtOffsetMinutes =
    Number.isInteger(tzOffset) && Math.abs(tzOffset) <= 840 ? tzOffset : undefined;

  const recordsLayout = sp.get('mode') === 'records';
  const buffer = await exportStatistics(filters, user, {
    enteredAtOffsetMinutes,
    layout: recordsLayout ? 'records' : undefined,
    refreshUser: requireUser,
  });
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': recordsLayout
        ? 'attachment'
        : 'attachment; filename="statistics.xlsx"',
      // 私有财务数据下载,禁止任何缓存层/浏览器磁盘缓存保留(与其他下载路由一致)。
      'Cache-Control': 'no-store',
    },
  });
});
