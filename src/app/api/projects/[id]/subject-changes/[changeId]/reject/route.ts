import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { rejectSubjectChange } from '@/server/services/subjectChange.service';

/**
 * POST /api/projects/:id/subject-changes/:changeId/reject — 驳回(PENDING→REJECTED)。
 * body = { opinion: string }(必填)。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; changeId: string }> }) => {
    const user = await requireUser();
    const { changeId } = await params;

    let opinion = '';
    try {
      const body = (await req.json()) as { opinion?: unknown };
      if (body && typeof body.opinion === 'string') {
        opinion = body.opinion;
      }
    } catch {
      // body 解析失败视为空意见。
    }

    const application = await rejectSubjectChange(changeId, user, opinion);
    return NextResponse.json({ application });
  },
);
