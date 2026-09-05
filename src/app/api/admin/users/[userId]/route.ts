import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { updateUserAccount } from '@/server/services/adminUser.service';

/**
 * PATCH /api/admin/users/:userId — 变更账户状态/角色(仅管理员交互会话)。
 * body = { status?: 'active'|'disabled', role?: 'ADMIN'|'USER' }。
 * 护栏:不可操作自己;不可降级/停用最后一个活跃 ADMIN;变更随事务写审计。
 */
export const PATCH = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ userId: string }> }) => {
    const user = await requireUser();
    const { userId } = await params;
    const body = (await req.json().catch(() => null)) as {
      status?: string;
      role?: string;
    } | null;
    if (!body || typeof body !== 'object') {
      throw new HTTPError(400, '请求体不是有效 JSON');
    }
    const updated = await updateUserAccount(user, userId, {
      status: body.status as 'active' | 'disabled' | undefined,
      role: body.role as 'ADMIN' | 'USER' | undefined,
    });
    return NextResponse.json(updated);
  },
);
