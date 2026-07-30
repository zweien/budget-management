import { NextRequest, NextResponse } from 'next/server';

import { requireUser, HTTPError } from '@/lib/auth/session';
import { archiveProject, getProject, updateProject } from '@/server/services/project.service';

/** GET /api/projects/:id — 项目详情。 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const project = await getProject(id, user);
    return NextResponse.json(project);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/** PATCH /api/projects/:id — 更新项目可改字段。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await req.json();
    const project = await updateProject(id, body, user);
    return NextResponse.json(project);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/** DELETE /api/projects/:id — 归档项目(软删除)。 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const project = await archiveProject(id, user);
    return NextResponse.json(project);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
