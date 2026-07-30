import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { updateRecord, type UpdateRecordInput } from '@/server/services/businessRecord.service';

const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/**
 * PATCH /api/projects/:id/records/:recordId — 修改业务记录(§8.5)。
 * body = UpdateRecordInput(全部字段可选):budgetYear/subjectId/amount/businessDate/
 * handler/summary/status/remark。返回 { record, overBudget }。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  try {
    const user = await requireUser();
    const { recordId } = await params;
    const body = (await req.json()) as UpdateRecordInput;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }
    if (body.status && !STATUS_SET.has(body.status)) {
      return NextResponse.json({ error: `状态参数无效:${body.status}` }, { status: 400 });
    }

    const result = await updateRecord(recordId, body, user);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
