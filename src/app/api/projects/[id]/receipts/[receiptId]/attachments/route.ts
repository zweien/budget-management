import { NextRequest, NextResponse } from 'next/server';

import { assertContentLengthBelow, withRoute } from '@/lib/api/withRoute';
import { env } from '@/lib/env';
import { requireUser } from '@/lib/auth/session';
import {
  createReceiptAttachment,
  listReceiptAttachments,
} from '@/server/services/receiptAttachment.service';

/**
 * POST /api/projects/:id/receipts/:receiptId/attachments — 上传到账流水附件。
 * multipart/form-data(file 字段);权限/校验/审计在服务层。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; receiptId: string }> }) => {
    const user = await requireUser();
    const { receiptId } = await params;

    // 同 record 附件:声明长度在 formData 缓冲前切断明显超限的上传。
    assertContentLengthBelow(req, env.MAX_ATTACHMENT_BYTES);

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少上传文件(file 字段)' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const meta = await createReceiptAttachment(
      receiptId,
      { name: file.name, type: file.type || 'application/octet-stream', size: file.size, buffer },
      user,
    );
    return NextResponse.json(meta, { status: 201 });
  },
);

/**
 * GET /api/projects/:id/receipts/:receiptId/attachments — 列出附件元数据(不含二进制)。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; receiptId: string }> }) => {
    const user = await requireUser();
    const { receiptId } = await params;
    const attachments = await listReceiptAttachments(receiptId, user);
    return NextResponse.json({ attachments });
  },
);
