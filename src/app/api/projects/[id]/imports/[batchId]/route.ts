import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { getImportBatch } from '@/server/services/excelImport.service';

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
    const preview = await getImportBatch(batchId, user);
    return NextResponse.json(preview);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
