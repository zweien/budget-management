import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  createSubjectChange,
  listSubjectChanges,
  type SubjectChangePayload,
} from '@/server/services/subjectChange.service';

/**
 * GET /api/projects/:id/subject-changes — 列出科目变更单。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const applications = await listSubjectChanges(id, user);
    return NextResponse.json({ applications });
  },
);

/**
 * POST /api/projects/:id/subject-changes — 创建科目变更草稿(§5.3)。
 * body = SubjectChangePayload:{ operations[] }。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as SubjectChangePayload;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }

    const application = await createSubjectChange(id, body, user);
    return NextResponse.json({ application }, { status: 201 });
  },
);
