import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { parseFundingReportOptions } from '@/lib/fundingReport';
import {
  createExportProgress,
  finishExportProgress,
  publicProgressError,
  updateExportProgress,
} from '@/server/exports/progress';
import { contentDispositionAttachment } from '@/server/services/migrationPackage.service';
import { DOCX_MIME, exportFundingReport } from '@/server/services/fundingReport.service';

/**
 * GET /api/projects/:id/export/funding-report — 生成经费报告 Word(CONTEXT.md「经费报告」)。
 * query:level=1|2|…|all(默认 2)、summary=列 key 逗号序、fields=字段 key 逗号序、
 * progress=客户端生成的随机 id(可选):生成过程写入导出进度注册表,前端轮询
 * GET /api/export/progress?id=… 展示阶段/百分比(值不含业务数据)。
 * 权限与台账导出同权(project:view);作废记录不计。中文文件名复用
 * contentDispositionAttachment(RFC 5987 + ASCII 兜底,引号/反斜杠安全)。
 */
export const GET = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const options = parseFundingReportOptions(req.nextUrl.searchParams);
    const progressId = req.nextUrl.searchParams.get('progress') ?? '';
    // 仅接受 8-64 位随机 id(客户端 crypto.randomUUID),防注册表被垃圾键灌满。
    const trackProgress = /^[A-Za-z0-9-]{8,64}$/.test(progressId) ? progressId : null;
    if (trackProgress) createExportProgress(trackProgress);

    try {
      const { buffer, filename } = await exportFundingReport(
        id,
        options,
        user,
        trackProgress
          ? (percent, phase) => updateExportProgress(trackProgress, percent, phase)
          : undefined,
      );
      // 成功:生成完毕、响应即将发出,进度落定 100%(响应 flush 很快,轮询方随即收尾)。
      if (trackProgress) finishExportProgress(trackProgress, 'done');
      return new NextResponse(buffer as unknown as BodyInit, {
        headers: {
          'Content-Type': DOCX_MIME,
          'Content-Disposition': contentDispositionAttachment(filename),
          // 私有财务数据下载,禁止任何缓存层/浏览器磁盘缓存保留(与其他下载路由一致)。
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      if (trackProgress) {
        // 错误文案白名单化:业务 HTTPError 保留原文,未知异常折叠为通用文案
        // (防 Prisma/IO 异常细节经进度端点外泄)。
        finishExportProgress(trackProgress, 'error', publicProgressError(error));
      }
      throw error;
    }
  },
);
