import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { submitSubjectChange } from '@/server/services/subjectChange.service';

/** POST /api/projects/:id/subject-changes/:changeId/submit — 提交(DRAFT→PENDING)。 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  try {
    const user = await requireUser();
    const { changeId } = await params;
    const application = await submitSubjectChange(changeId, user);
    return NextResponse.json({ application });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
