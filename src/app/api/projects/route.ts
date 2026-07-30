import { NextRequest, NextResponse } from 'next/server';

import { requireUser, HTTPError } from '@/lib/auth/session';
import { createProject, listProjects } from '@/server/services/project.service';

/** GET /api/projects — 列出当前用户可访问的项目。 */
export async function GET() {
  try {
    const user = await requireUser();
    const projects = await listProjects(user);
    return NextResponse.json(projects);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

/** POST /api/projects — 新建项目。 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = await req.json();
    const project = await createProject(body, user);
    return NextResponse.json(project, { status: 201 });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
