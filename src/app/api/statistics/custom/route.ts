import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  customStatistics,
  CUSTOM_SORT_FIELDS,
  type CustomSortField,
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
export const GET = withRoute(async (req: NextRequest) => {
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

  // ---- v0.15 扩展:服务端筛选/排序/分页(全局录入页驱动) ----
  for (const key of ['projectIds', 'subjectNames', 'handlers', 'creatorNames'] as const) {
    const values = sp.getAll(key).filter(Boolean);
    if (values.length > 0) filters[key] = values;
  }
  const budgetYears = sp
    .getAll('budgetYears')
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v >= 1900 && v <= 9999);
  if (budgetYears.length > 0) filters.budgetYears = budgetYears;
  const statuses = sp.getAll('statuses').filter((v) => STATUS_SET.has(v));
  if (statuses.length > 0) filters.statuses = statuses as BusinessStatus[];

  const remark = sp.get('remark');
  if (remark) filters.remark = remark;
  const summary = sp.get('summary');
  if (summary) filters.summary = summary;
  const docNo = sp.get('docNo');
  if (docNo) filters.docNo = docNo;

  if (sp.get('completedDateEmpty') === '1') filters.completedDateEmpty = true;
  const completedDateFrom = sp.get('completedDateFrom');
  if (completedDateFrom) filters.completedDateFrom = completedDateFrom;
  const completedDateTo = sp.get('completedDateTo');
  if (completedDateTo) filters.completedDateTo = completedDateTo;

  const amountFrom = sp.get('amountFrom');
  if (amountFrom) filters.amountFrom = amountFrom;
  const amountTo = sp.get('amountTo');
  if (amountTo) filters.amountTo = amountTo;

  const sortField = sp.get('sortField');
  const sortDir = sp.get('sortDir');
  if (sortField && (sortDir === 'asc' || sortDir === 'desc')) {
    if (sortField in CUSTOM_SORT_FIELDS) {
      filters.sort = { field: sortField as CustomSortField, dir: sortDir };
    } else {
      return NextResponse.json({ error: `排序字段无效:${sortField}` }, { status: 400 });
    }
  }

  const page = sp.get('page') !== null ? Number.parseInt(sp.get('page')!, 10) : undefined;
  const pageSize =
    sp.get('pageSize') !== null ? Number.parseInt(sp.get('pageSize')!, 10) : undefined;
  if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 100000)) {
    return NextResponse.json({ error: 'page 参数无效' }, { status: 400 });
  }
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500)) {
    return NextResponse.json({ error: 'pageSize 参数无效(1-500)' }, { status: 400 });
  }
  if (page !== undefined && pageSize !== undefined) {
    filters.page = page;
    filters.pageSize = pageSize;
  }

  const result = await customStatistics(filters, user);
  return NextResponse.json(result);
});
