import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth/session';
import { confirmImport } from '@/server/services/excelImport.service';
import { confirmSettlementImport } from '@/server/services/settlementImport.service';
import { SETTLEMENT_TEMPLATE_VERSION } from '@/lib/excel/settlement';

/**
 * POST /api/projects/:id/imports/:batchId/confirm — 确认入库(§10 阶段二)。
 * body = { selectedRowIds: string[] }(用户在预览页勾选的有效/重复行 id)。
 * 返回 { created, batchId }。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; batchId: string }> }) => {
    const user = await requireUser();
    const { batchId } = await params;

    const body = (await req.json().catch(() => null)) as { selectedRowIds?: unknown } | null;
    if (!body || !Array.isArray(body.selectedRowIds)) {
      return NextResponse.json({ error: '请求体无效:需要 selectedRowIds 数组' }, { status: 400 });
    }
    const selectedRowIds = body.selectedRowIds.filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );

    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { templateVersion: true },
    });
    if (!batch) {
      return NextResponse.json({ error: '导入批次不存在' }, { status: 404 });
    }
    const result =
      batch.templateVersion === SETTLEMENT_TEMPLATE_VERSION
        ? await confirmSettlementImport(batchId, selectedRowIds, user)
        : await confirmImport(batchId, selectedRowIds, user);
    return NextResponse.json(result);
  },
);
