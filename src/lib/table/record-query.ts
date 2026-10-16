import { format } from 'date-fns';
import type { ColumnFiltersState, SortingState } from '@tanstack/react-table';
import { VALUES_FILTER_NONE, type DateRangeFilterValue } from '@/lib/table/filter-fns';

/** 两个业务记录页共享服务端筛选协议，分页与导出复用同一查询条件。 */
export function buildRecordQuery(
  filters: ColumnFiltersState,
  sorting: SortingState,
  options: {
    page: number;
    pageSize: number;
    projectId?: string;
    projectIdByLabel?: ReadonlyMap<string, string>;
    writableProjectIds?: ReadonlySet<string>;
  },
): URLSearchParams {
  const params = new URLSearchParams();
  const projectIds: string[] = [];
  for (const { id, value } of filters) {
    if (value === undefined || value === null) continue;
    if (id === 'project') {
      const ids = (value as string[]).flatMap((label) => {
        const projectId = options.projectIdByLabel?.get(label);
        return projectId ? [projectId] : [];
      });
      projectIds.push(...(ids.length ? ids : [VALUES_FILTER_NONE]));
    } else if (id === 'status') {
      const values = value as string[];
      const statuses = values.filter((s) => s !== '__void__');
      if (!values.length) params.append('statuses', VALUES_FILTER_NONE);
      for (const status of statuses) params.append('statuses', status);
      if (values.includes('__void__')) {
        params.set('includeVoid', '1');
        if (!statuses.length) params.set('voidOnly', '1');
      }
    } else if (['budgetYear', 'subject', 'subjectId', 'handler', 'creatorName'].includes(id)) {
      const key = {
        budgetYear: 'budgetYears',
        subject: 'subjectNames',
        subjectId: 'subjectIds',
        handler: 'handlers',
        creatorName: 'creatorNames',
      }[id]!;
      const values = value as Array<string | number>;
      for (const item of values.length ? values : [VALUES_FILTER_NONE])
        params.append(key, String(item));
    } else if (['summary', 'remark', 'docNo'].includes(id)) {
      params.set(id, String(value));
    } else if (id === 'amount') {
      const range = value as { min?: string; max?: string };
      if (range.min) params.set('amountFrom', range.min);
      if (range.max) params.set('amountTo', range.max);
    } else if (['businessDate', 'completedDate', 'enteredAt'].includes(id)) {
      const range = value as DateRangeFilterValue;
      if (id === 'completedDate' && range.empty) params.set('completedDateEmpty', '1');
      const boundary = (date: Date, end: boolean) =>
        id === 'enteredAt'
          ? new Date(
              date.getFullYear(),
              date.getMonth(),
              date.getDate() + (end ? 1 : 0),
            ).toISOString()
          : format(date, 'yyyy-MM-dd');
      if (range.from) params.set(`${id}From`, boundary(new Date(range.from), false));
      if (range.to) params.set(`${id}To`, boundary(new Date(range.to), true));
    }
  }
  if (options.projectId) params.set('projectId', options.projectId);
  let allowed = projectIds;
  if (options.writableProjectIds && !projectIds.includes(VALUES_FILTER_NONE)) {
    allowed = projectIds.length
      ? projectIds.filter((id) => options.writableProjectIds!.has(id))
      : Array.from(options.writableProjectIds);
    if (!allowed.length) allowed = [VALUES_FILTER_NONE];
  }
  for (const id of allowed) params.append('projectIds', id);
  const sort = sorting[0];
  if (sort) {
    params.set('sortField', sort.id === 'subjectId' ? 'subject' : sort.id);
    params.set('sortDir', sort.desc ? 'desc' : 'asc');
  }
  params.set('page', String(options.page));
  params.set('pageSize', String(options.pageSize));
  return params;
}
