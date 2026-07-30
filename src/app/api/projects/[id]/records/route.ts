import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  createRecord,
  listRecords,
  type CreateRecordInput,
  type ListRecordsFilters,
} from '@/server/services/businessRecord.service';

const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/**
 * GET /api/projects/:id/records — 列出业务记录(§8)。
 * Query:year, subjectId, status, includeVoid(0/1)。
 * 默认不含作废记录。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
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

    const records = await listRecords(id, filters, user);
    return NextResponse.json({ records });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/**
 * POST /api/projects/:id/records — 新增业务记录(§8.1/8.4)。
 * 返回 { record, overBudget };overBudget=true 表示超预算预警(§8.4 仍保存)。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
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
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
