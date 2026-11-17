import { NextRequest, NextResponse } from 'next/server';

import { readJson, withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  matchAttachmentsPreview,
  parseMatchPreviewFiles,
} from '@/server/services/attachmentMatch.service';

/**
 * POST /api/projects/:id/attachments/match-preview — 批量附件导入的匹配预览(项目内入口)。
 * body = { files: [{ name, contentHash? }] }(只传文件名与可选 SHA-256,不传文件字节)。
 * 权限:record:edit(服务层);返回逐文件 matched / ambiguous / unmatched(含原因)。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const files = parseMatchPreviewFiles(await readJson(req).catch(() => null));
    const result = await matchAttachmentsPreview(files, user, id);
    return NextResponse.json(result);
  },
);
