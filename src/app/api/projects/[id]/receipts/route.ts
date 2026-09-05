import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  createReceipt,
  listReceipts,
  type CreateReceiptInput,
} from '@/server/services/receipt.service';

/**
 * GET /api/projects/:id/receipts — 列出到账记录 + 到账累计(§9)。
 * 返回 { records, cumulative }。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const result = await listReceipts(id, user);
    return NextResponse.json(result);
  },
);

/**
 * POST /api/projects/:id/receipts — 新增到账记录(§9.1)。
 * body = CreateReceiptInput(receiptDate, amount, summary?, remark?)。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as CreateReceiptInput;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const record = await createReceipt(id, body, user);
    return NextResponse.json({ record }, { status: 201 });
  },
);
