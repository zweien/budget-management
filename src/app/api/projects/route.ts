import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { createProject, listProjects } from '@/server/services/project.service';

/** GET /api/projects — 列出全部项目(v0.3.0 起普通用户全局只读)。 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  // includeArchived=1:含已归档项目(项目管理页「显示已归档」开关)。
  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1';
  const projects = await listProjects(user, { includeArchived });
  return NextResponse.json(projects);
});

/** POST /api/projects — 新建项目。 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await req.json();
  const project = await createProject(body, user);
  return NextResponse.json(project, { status: 201 });
});
