import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { unarchiveProject } from '@/server/services/project.service';

/** POST /api/projects/:id/unarchive — 恢复归档项目(软删除的逆操作)。 */
export const POST = withRoute(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const project = await unarchiveProject(id, user);
    return NextResponse.json(project);
  },
);
