import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { archiveProject, getProject, updateProject } from '@/server/services/project.service';

/** GET /api/projects/:id — 项目详情。 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const project = await getProject(id, user);
    return NextResponse.json(project);
  },
);

/** PATCH /api/projects/:id — 更新项目可改字段。 */
export const PATCH = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const body = await req.json();
    const project = await updateProject(id, body, user);
    return NextResponse.json(project);
  },
);

/** DELETE /api/projects/:id — 归档项目(软删除)。 */
export const DELETE = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const project = await archiveProject(id, user);
    return NextResponse.json(project);
  },
);
