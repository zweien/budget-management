import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { getImportFile } from '@/server/services/settlementImport.service';

/**
 * GET /api/projects/:id/imports/:batchId/file — 下载批次留存的上传原件(.xlsx)。
 * 权限:project:view(与附件下载一致)。历史批次未留存 → 404。
 * Content-Disposition: attachment; filename*=UTF-8''<encoded>(支持中文文件名)。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; batchId: string }> }) => {
    const user = await requireUser();
    const { id, batchId } = await params;
    const { fileName, data } = await getImportFile(batchId, id, user);
    // RFC 5987 编码中文文件名;ASCII 兜底固定扩展名(与附件下载同款)。
    const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    return new NextResponse(data as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="import.xlsx"; filename*=UTF-8''${encoded}`,
        'Content-Length': String(data.length),
        'Cache-Control': 'no-store',
      },
    });
  },
);
