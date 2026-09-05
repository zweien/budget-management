import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { submitSubjectChange } from '@/server/services/subjectChange.service';

/** POST /api/projects/:id/subject-changes/:changeId/submit — 提交(DRAFT→PENDING)。 */
export const POST = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string; changeId: string }> }) => {
    const user = await requireUser();
    const { changeId } = await params;
    const application = await submitSubjectChange(changeId, user);
    return NextResponse.json({ application });
  },
);
