import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { listProjectsWithPermissions } from '@/server/services/project.service';

/**
 * GET /api/me/projects — 全部项目 + 当前用户权限标记(canEdit/canWriteRecords)。
 * 统一业务录入页的数据源:录入表单的项目选择(可写)+ 列表行级编辑门控。
 */
export const GET = withRoute(async () => {
  const user = await requireUser();
  const projects = await listProjectsWithPermissions(user);
  return NextResponse.json(projects);
});
