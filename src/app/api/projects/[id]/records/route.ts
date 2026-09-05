import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  createRecord,
  listRecords,
  type CreateRecordInput,
  type ListRecordsFilters,
} from '@/server/services/businessRecord.service';

const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/**
 * GET /api/projects/:id/records — 列出业务记录(§8)。
 * Query:year, subjectId, status, includeVoid(0/1),
 *       handler(包含), summary(包含), businessDateFrom/To(yyyy-mm-dd 闭区间)。
 * 默认不含作废记录。
 */
export const GET = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const sp = req.nextUrl.searchParams;

    const filters: ListRecordsFilters = {};
    const yearParam = sp.get('year');
    if (yearParam !== null) {
      const year = Number.parseInt(yearParam, 10);
      if (!Number.isInteger(year) || year < 1900 || year > 9999) {
        return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
      }
      filters.year = year;
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
    const includeVoidParam = sp.get('includeVoid');
    if (includeVoidParam === '1' || includeVoidParam === 'true') {
      filters.includeVoid = true;
    }
    const handler = sp.get('handler')?.trim();
    if (handler) filters.handler = handler;
    const summary = sp.get('summary')?.trim();
    if (summary) filters.summary = summary;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const dateFrom = sp.get('businessDateFrom');
    if (dateFrom) {
      if (!DATE_RE.test(dateFrom)) {
        return NextResponse.json(
          { error: 'businessDateFrom 格式应为 yyyy-mm-dd' },
          { status: 400 },
        );
      }
      filters.businessDateFrom = dateFrom;
    }
    const dateTo = sp.get('businessDateTo');
    if (dateTo) {
      if (!DATE_RE.test(dateTo)) {
        return NextResponse.json({ error: 'businessDateTo 格式应为 yyyy-mm-dd' }, { status: 400 });
      }
      filters.businessDateTo = dateTo;
    }

    const records = await listRecords(id, filters, user);
    return NextResponse.json({ records });
  },
);

/**
 * POST /api/projects/:id/records — 新增业务记录(§8.1/8.4)。
 * 返回 { record, overBudget, overTotalBudget, overSubjectTotal };超预算仅预警仍保存
 * (§8.4 年度科目口径 / §8.4b 项目总预算与 GENERAL 科目总预算口径)。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as CreateRecordInput;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }
    if (body.status && !STATUS_SET.has(body.status)) {
      return NextResponse.json({ error: `状态参数无效:${body.status}` }, { status: 400 });
    }

    const result = await createRecord(id, body, user);
    return NextResponse.json(result, { status: 201 });
  },
);
