import { NextRequest, NextResponse } from 'next/server';

import { readJson, withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  createReceipt,
  listReceipts,
  type CreateReceiptInput,
} from '@/server/services/receipt.service';

/**
 * GET /api/projects/:id/receipts — 列出到账记录 + 到账累计(§9)。
 * 可选分页 page/pageSize(成对提供;缺省全量,安全审计 bm1-rec 资源加固)。
 * 返回 { records, cumulative, total? }(累计恒为全集口径)。
 */
export const GET = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const sp = req.nextUrl.searchParams;
    let paging: { page: number; pageSize: number } | undefined;
    const pageParam = sp.get('page');
    const pageSizeParam = sp.get('pageSize');
    if (pageParam !== null || pageSizeParam !== null) {
      const page = Number(pageParam);
      const pageSize = Number(pageSizeParam);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 500
      ) {
        return NextResponse.json(
          { error: '分页参数无效:page ≥ 1,pageSize 1~500(两者须成对提供)' },
          { status: 400 },
        );
      }
      paging = { page, pageSize };
    }
    const result = await listReceipts(id, user, paging);
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
    const body = (await readJson(req)) as CreateReceiptInput;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const record = await createReceipt(id, body, user);
    return NextResponse.json({ record }, { status: 201 });
  },
);
