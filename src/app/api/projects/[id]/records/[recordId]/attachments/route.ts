import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { createAttachment, listAttachments } from '@/server/services/recordAttachment.service';

/**
 * POST /api/projects/:id/records/:recordId/attachments — 上传单个报销凭证附件。
 * 接受 multipart/form-data(file 字段)。
 * 权限/校验/审计在服务层。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; recordId: string }> }) => {
    const user = await requireUser();
    const { recordId } = await params;

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少上传文件(file 字段)' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const meta = await createAttachment(
      recordId,
      { name: file.name, type: file.type || 'application/octet-stream', size: file.size, buffer },
      user,
    );
    return NextResponse.json(meta, { status: 201 });
  },
);

/**
 * GET /api/projects/:id/records/:recordId/attachments — 列出该记录的附件元数据(不含二进制)。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; recordId: string }> }) => {
    const user = await requireUser();
    const { recordId } = await params;
    const attachments = await listAttachments(recordId, user);
    return NextResponse.json({ attachments });
  },
);
