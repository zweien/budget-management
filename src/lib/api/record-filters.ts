import { BusinessStatus } from '@prisma/client';
import { HTTPError } from '@/lib/auth/session';
import {
  CUSTOM_SORT_FIELDS,
  VALUES_FILTER_NONE,
  type CustomSortField,
  type CustomStatisticsFilters,
} from '@/server/services/statistics.service';
const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/** 列表与导出共用筛选解析，避免导出遗漏多值/空集/日期条件。 */
export function parseRecordFilters(sp: URLSearchParams): CustomStatisticsFilters {
  const filters: CustomStatisticsFilters = {};
  const projectId = sp.get('projectId');
  if (projectId) filters.projectId = projectId;

  const yearParam = sp.get('budgetYear');
  if (yearParam !== null) {
    const year = Number.parseInt(yearParam, 10);
    if (!Number.isInteger(year) || year < 1900 || year > 9999) {
      throw new HTTPError(400, '年度参数无效');
    }
    filters.budgetYear = year;
  }

  const subject = sp.get('subject');
  if (subject) filters.subject = subject;

  const status = sp.get('status');
  if (status) {
    if (!STATUS_SET.has(status)) {
      throw new HTTPError(400, `状态参数无效:${status}`);
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
  for (const key of [
    'projectIds',
    'subjectNames',
    'subjectIds',
    'handlers',
    'creatorNames',
  ] as const) {
    const values = sp.getAll(key).filter(Boolean);
    if (values.length > 0) filters[key] = values;
  }
  // 取消全选哨兵:显式空集 → 维度匹配零行(优先于数值/枚举白名单解析)。
  if (sp.getAll('budgetYears').includes(VALUES_FILTER_NONE)) {
    filters.budgetYears = [VALUES_FILTER_NONE];
  } else {
    const budgetYears = sp
      .getAll('budgetYears')
      .map((v) => Number.parseInt(v, 10))
      .filter((v) => Number.isInteger(v) && v >= 1900 && v <= 9999);
    if (budgetYears.length > 0) filters.budgetYears = budgetYears;
  }
  if (sp.getAll('statuses').includes(VALUES_FILTER_NONE)) {
    filters.statuses = [VALUES_FILTER_NONE];
  } else {
    const statuses = sp.getAll('statuses').filter((v) => STATUS_SET.has(v));
    if (statuses.length > 0) filters.statuses = statuses as BusinessStatus[];
  }
  if (sp.get('voidOnly') === '1') filters.voidOnly = true;

  const remark = sp.get('remark');
  if (remark) filters.remark = remark;
  const summary = sp.get('summary');
  if (summary) filters.summary = summary;
  const docNo = sp.get('docNo');
  if (docNo) filters.docNo = docNo;

  const enteredAtFrom = sp.get('enteredAtFrom');
  if (enteredAtFrom) filters.enteredAtFrom = enteredAtFrom;
  const enteredAtTo = sp.get('enteredAtTo');
  if (enteredAtTo) filters.enteredAtTo = enteredAtTo;
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
    if (Object.hasOwn(CUSTOM_SORT_FIELDS, sortField)) {
      filters.sort = { field: sortField as CustomSortField, dir: sortDir };
    } else {
      throw new HTTPError(400, `排序字段无效:${sortField}`);
    }
  }

  const page = sp.get('page') !== null ? Number.parseInt(sp.get('page')!, 10) : undefined;
  const pageSize =
    sp.get('pageSize') !== null ? Number.parseInt(sp.get('pageSize')!, 10) : undefined;
  if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 100000)) {
    throw new HTTPError(400, 'page 参数无效');
  }
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500)) {
    throw new HTTPError(400, 'pageSize 参数无效(1-500)');
  }
  if (page !== undefined && pageSize !== undefined) {
    filters.page = page;
    filters.pageSize = pageSize;
  }

  return filters;
}
