import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { getImportBatch } from '@/server/services/excelImport.service';
import {
  deleteImportBatch,
  getSettlementBatch,
  updateSettlementRows,
} from '@/server/services/settlementImport.service';
import { SETTLEMENT_TEMPLATE_VERSION } from '@/lib/excel/settlement';

/**
 * GET /api/projects/:id/imports/:batchId — 取导入批次预览(§10 阶段一结果)。
 * 返回 { batchId, projectId, fileName, status, valid, errors, duplicates, ... }。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  try {
    const user = await requireUser();
    const { batchId } = await params;
    // 按批次来源格式分流预览载荷(标准模板 / 个人结算单)。
    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { templateVersion: true },
    });
    if (!batch) {
      return NextResponse.json({ error: '导入批次不存在' }, { status: 404 });
    }
    const preview =
      batch.templateVersion === SETTLEMENT_TEMPLATE_VERSION
        ? await getSettlementBatch(batchId, user)
        : await getImportBatch(batchId, user);
    return NextResponse.json(preview);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/**
 * PATCH /api/projects/:id/imports/:batchId — 暂存结算单批次的行级修改。
 * body = { updates: [{ rowId, subjectId?|null, budgetYear?, forcedImport? }] }。
 * 每次变更即时持久化;批次保持 pending,可离开后从「进行中批次」继续。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  try {
    const user = await requireUser();
    const { batchId } = await params;

    const body = (await req.json().catch(() => null)) as { updates?: unknown } | null;
    if (!body || !Array.isArray(body.updates)) {
      return NextResponse.json({ error: '请求体无效:需要 updates 数组' }, { status: 400 });
    }
    const updates = (body.updates as unknown[]).filter(
      (v): v is NonNullable<unknown> => v !== null && typeof v === 'object',
    ) as Parameters<typeof updateSettlementRows>[1];
    for (const u of updates) {
      if (typeof u.rowId !== 'string' || u.rowId.length === 0) {
        return NextResponse.json({ error: 'updates 中缺少 rowId' }, { status: 400 });
      }
    }

    await updateSettlementRows(batchId, updates, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/**
 * DELETE /api/projects/:id/imports/:batchId — 删除未导入批次(仅 pending)。
 * 已确认批次是入账历史,不可删除(409)。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  try {
    const user = await requireUser();
    const { batchId } = await params;
    await deleteImportBatch(batchId, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
