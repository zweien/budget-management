import { NextResponse } from 'next/server';

import { requireUser, HTTPError } from '@/lib/auth/session';
import { unarchiveProject } from '@/server/services/project.service';

/** POST /api/projects/:id/unarchive — 恢复归档项目(软删除的逆操作)。 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const project = await unarchiveProject(id, user);
    return NextResponse.json(project);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
