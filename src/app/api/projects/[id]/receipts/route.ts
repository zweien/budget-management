import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  createReceipt,
  listReceipts,
  type CreateReceiptInput,
} from '@/server/services/receipt.service';

/**
 * GET /api/projects/:id/receipts — 列出到账记录 + 到账累计(§9)。
 * 返回 { records, cumulative }。
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const result = await listReceipts(id, user);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/**
 * POST /api/projects/:id/receipts — 新增到账记录(§9.1)。
 * body = CreateReceiptInput(receiptDate, amount, summary?, remark?)。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as CreateReceiptInput;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const record = await createReceipt(id, body, user);
    return NextResponse.json({ record }, { status: 201 });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
