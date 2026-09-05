import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { voidRecordsBatch } from '@/server/services/businessRecord.service';

/**
 * POST /api/projects/:id/records/void-batch — 批量作废业务记录。
 * body = { recordIds: string[], reason: string }(原因全部行共用;已作废行自动跳过)。
 * 返回 { voided, skipped }。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;

    const body = (await req.json().catch(() => null)) as {
      recordIds?: unknown;
      reason?: unknown;
    } | null;
    if (!body || !Array.isArray(body.recordIds) || typeof body.reason !== 'string') {
      return NextResponse.json(
        { error: '请求体无效:需要 recordIds 数组与 reason 字符串' },
        { status: 400 },
      );
    }
    const recordIds = body.recordIds.filter((v): v is string => typeof v === 'string');

    const result = await voidRecordsBatch(id, recordIds, body.reason, user);
    return NextResponse.json(result);
  },
);
