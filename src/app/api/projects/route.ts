import { NextRequest, NextResponse } from 'next/server';

import { requireUser, HTTPError } from '@/lib/auth/session';
import { createProject, listProjects } from '@/server/services/project.service';

/** GET /api/projects — 列出全部项目(v0.3.0 起普通用户全局只读)。 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    // includeArchived=1:含已归档项目(项目管理页「显示已归档」开关)。
    const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1';
    const projects = await listProjects(user, { includeArchived });
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
