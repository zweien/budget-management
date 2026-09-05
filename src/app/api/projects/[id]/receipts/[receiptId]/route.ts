import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  deleteReceipt,
  updateReceipt,
  type UpdateReceiptInput,
} from '@/server/services/receipt.service';

/**
 * PATCH /api/projects/:id/receipts/:receiptId — 修改到账记录(§9)。
 * body = UpdateReceiptInput(receiptDate?/amount?/summary?/remark?)。
 */
export const PATCH = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; receiptId: string }> }) => {
    const user = await requireUser();
    const { receiptId } = await params;
    const body = (await req.json()) as UpdateReceiptInput;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const record = await updateReceipt(receiptId, body, user);
    return NextResponse.json({ record });
  },
);

/**
 * DELETE /api/projects/:id/receipts/:receiptId — 删除到账记录(§9,物理删除)。
 * 到账为参考数据;删除保留一条 delete 审计日志。
 */
export const DELETE = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; receiptId: string }> }) => {
    const user = await requireUser();
    const { receiptId } = await params;
    await deleteReceipt(receiptId, user);
    return new NextResponse(null, { status: 204 });
  },
);
