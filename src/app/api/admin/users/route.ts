import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { listAdminUsers } from '@/server/services/adminUser.service';

/**
 * GET /api/admin/users — 用户管理列表(仅管理员交互会话)。
 * 含停用账号、服务账号标记(活跃无人值守 Key)、全部项目成员关系。
 * 返回 { users: AdminUserRow[] }。
 */
export const GET = withRoute(async () => {
  const user = await requireUser();
  const users = await listAdminUsers(user);
  return NextResponse.json({ users });
});
