import { NextRequest, NextResponse } from 'next/server';
import { BusinessStatus } from '@prisma/client';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { switchStatus } from '@/server/services/businessRecord.service';

const STATUS_SET = new Set<string>(Object.values(BusinessStatus));

/**
 * POST /api/projects/:id/records/:recordId/status — 切换业务记录状态(§8.3 四态自由切换)。
 * body = { status: BusinessStatus }。返回 { record }。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; recordId: string }> }) => {
    const user = await requireUser();
    const { recordId } = await params;
    const body = (await req.json().catch(() => ({}))) as { status?: BusinessStatus };

    if (!body.status || !STATUS_SET.has(body.status)) {
      return NextResponse.json(
        { error: `status 参数无效,仅允许 ${Object.values(BusinessStatus).join('/')}` },
        { status: 400 },
      );
    }

    const record = await switchStatus(recordId, body.status, user);
    return NextResponse.json({ record });
  },
);
