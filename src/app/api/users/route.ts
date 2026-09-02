import { NextResponse } from 'next/server';

import { getCurrentUser, HTTPError } from '@/lib/auth/session';
import { can, denyApiKeyCrossProject } from '@/lib/auth/permissions';
import { env } from '@/lib/env';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/users — 列出用户。
 *
 * - mock 模式:返回全部 active 用户(顶栏身份切换器需要完整列表,与角色无关);
 *   未登录时放行返回 ADMIN 最小集(bootstrap)。
 * - SSO 模式:仅 ADMIN(user:list 动作)可查全量——成员管理/新建项目的负责人选择器。
 */
export async function GET() {
  try {
    // mock 模式是开发工具:不看角色,直接给全量(选择器可切到任意身份)。
    if (env.MOCK_AUTH) {
      const users = await prisma.user.findMany({
        where: { status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, role: true },
      });
      return NextResponse.json(users);
    }

    const user = await getCurrentUser();
    if (!user) {
      throw new HTTPError(401, '未登录');
    }
    denyApiKeyCrossProject(user); // 用户列表为跨项目数据:指定项目范围的凭证拒绝(codex P1)
    if (!can(user, 'user:list')) {
      throw new HTTPError(403, '仅管理员可列出全部用户');
    }
    const users = await prisma.user.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, role: true },
    });
    return NextResponse.json(users);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
