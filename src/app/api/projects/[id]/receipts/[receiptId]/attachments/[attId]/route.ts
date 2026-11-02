import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  deleteReceiptAttachment,
  getReceiptAttachmentData,
} from '@/server/services/receiptAttachment.service';

/**
 * GET /api/projects/:id/receipts/:receiptId/attachments/:attId — 下载附件二进制。
 * Content-Disposition 编码与 record 附件同款(RFC 5987 + ASCII 兜底)。
 */
export const GET = withRoute(
  async (
    _req: NextRequest,
    { params }: { params: Promise<{ id: string; receiptId: string; attId: string }> },
  ) => {
    const user = await requireUser();
    const { receiptId, attId } = await params;
    const { meta, data } = await getReceiptAttachmentData(attId, receiptId, user);
    const encoded = encodeURIComponent(meta.fileName)
      .replace(/['()]/g, escape)
      .replace(/\*/g, '%2A');
    const ext =
      meta.contentType === 'application/pdf'
        ? '.pdf'
        : meta.contentType.startsWith('image/')
          ? `.${meta.contentType.split('/')[1]}`
          : '';
    const asciiFallback = `attachment${ext}`;
    return new NextResponse(data as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': meta.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
        'Content-Length': String(meta.sizeBytes),
        'Cache-Control': 'no-store',
      },
    });
  },
);

/** DELETE /api/projects/:id/receipts/:receiptId/attachments/:attId — 删除附件(物理删除 + 审计)。 */
export const DELETE = withRoute(
  async (
    _req: NextRequest,
    { params }: { params: Promise<{ id: string; receiptId: string; attId: string }> },
  ) => {
    const user = await requireUser();
    const { receiptId, attId } = await params;
    await deleteReceiptAttachment(attId, receiptId, user);
    return new NextResponse(null, { status: 204 });
  },
);
