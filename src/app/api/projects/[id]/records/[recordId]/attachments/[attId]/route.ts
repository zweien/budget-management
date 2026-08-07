import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { deleteAttachment, getAttachmentData } from '@/server/services/recordAttachment.service';

/**
 * GET /api/projects/:id/records/:recordId/attachments/:attId — 下载附件二进制。
 * Content-Disposition: attachment; filename*=UTF-8''<encoded>(支持中文文件名)。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string; attId: string }> },
) {
  try {
    const user = await requireUser();
    const { attId } = await params;
    const { meta, data } = await getAttachmentData(attId, user);
    // RFC 5987 编码中文文件名。
    const encoded = encodeURIComponent(meta.fileName)
      .replace(/['()]/g, escape)
      .replace(/\*/g, '%2A');
    // ASCII 兜底:解析旧式 `filename="..."` 的客户端(如本仓库 client.ts)能拿到合理扩展名;
    // 不识别 ASCII 的字符一律丢,优先保留扩展名而非乱码文件名。
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
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** DELETE /api/projects/:id/records/:recordId/attachments/:attId — 删除附件(物理删除 + 审计)。 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string; attId: string }> },
) {
  try {
    const user = await requireUser();
    const { attId } = await params;
    await deleteAttachment(attId, user);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
