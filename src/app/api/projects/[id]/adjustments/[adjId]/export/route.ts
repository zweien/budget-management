import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import {
  exportAdjustmentDocx,
  type ExportDimension,
} from '@/server/services/adjustmentExport.service';

/**
 * GET /api/projects/:id/adjustments/:adjId/export?dim=total|annual
 * 导出某次预算调整为 docx(按模板填充)。
 * dim=total → 总预算维度;dim=annual → 年度预算维度。两个维度各一份独立 docx。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; adjId: string }> },
) {
  try {
    const user = await requireUser();
    const { adjId } = await params;

    const url = new URL(_req.url);
    const dimParam = url.searchParams.get('dim');
    const dimension: ExportDimension = dimParam === 'annual' ? 'annual' : 'total';

    const buffer = await exportAdjustmentDocx(adjId, dimension, user);

    const dimLabel = dimension === 'total' ? '总预算调整' : '年度预算调整';
    // 中文文件名只能放 RFC 5987 编码的 filename* 段(filename= 段须 ASCII)。
    const filenameEncoded = encodeURIComponent(`${dimLabel}.docx`);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${filenameEncoded}`,
      },
    });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// 显式声明支持的路由参数(Next.js App Router 静态分析)。
export const dynamic = 'force-dynamic';
