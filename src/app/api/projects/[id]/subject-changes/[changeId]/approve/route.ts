import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { approveSubjectChange } from '@/server/services/subjectChange.service';

/**
 * POST /api/projects/:id/subject-changes/:changeId/approve — 审批通过(应用 afterSnapshot)。
 * body = { opinion?: string }。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string; changeId: string }> }) => {
    const user = await requireUser();
    const { changeId } = await params;

    let opinion: string | undefined;
    try {
      const body = (await req.json()) as { opinion?: unknown };
      if (body && typeof body.opinion === 'string') {
        opinion = body.opinion;
      }
    } catch {
      // body 可空。
    }

    const application = await approveSubjectChange(changeId, user, opinion);
    return NextResponse.json({ application });
  },
);
