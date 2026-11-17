import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { parseFundingReportOptions } from '@/lib/fundingReport';
import { contentDispositionAttachment } from '@/server/services/migrationPackage.service';
import { DOCX_MIME, exportFundingReport } from '@/server/services/fundingReport.service';

/**
 * GET /api/projects/:id/export/funding-report — 生成经费报告 Word(CONTEXT.md「经费报告」)。
 * query:level=1|2|…|all(默认 2)、summary=列 key 逗号序、fields=字段 key 逗号序。
 * 权限与台账导出同权(project:view);作废记录不计。中文文件名复用
 * contentDispositionAttachment(RFC 5987 + ASCII 兜底,引号/反斜杠安全)。
 */
export const GET = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const options = parseFundingReportOptions(req.nextUrl.searchParams);

    const { buffer, filename } = await exportFundingReport(id, options, user);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': DOCX_MIME,
        'Content-Disposition': contentDispositionAttachment(filename),
        // 私有财务数据下载,禁止任何缓存层/浏览器磁盘缓存保留(与其他下载路由一致)。
        'Cache-Control': 'no-store',
      },
    });
  },
);
