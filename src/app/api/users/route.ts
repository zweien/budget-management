import { NextResponse } from 'next/server';

import { getCurrentUser, HTTPError } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/users — 列出用户(V1 mock 鉴权用)。
 *
 * 用于 dashboard 顶部"模拟用户选择器"。bootstrap 难点:`/api/users` 本身需要鉴权,
 * 但用户首次进入时尚未选择身份 → 无法登录看用户列表。
 * 解法:无 `x-mock-user-id` 时,放行返回"种子 admin 用户"的最小列表(仅 id/name/role),
 * 仅供选择器 bootstrap;一旦登录,即按 admin-only 权限校验,返回全部 active 用户。
 */
export async function GET() {
  try {
    const user = await getCurrentUser();

    // 已登录:按原计划走 admin-only 校验,返回全部用户。
    if (user) {
      if (!can(user, 'project:viewAll')) {
        throw new HTTPError(403, '仅预算管理员可列出全部用户');
      }
      const users = await prisma.user.findMany({
        where: { status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, role: true },
      });
      return NextResponse.json(users);
    }

    // 未登录 bootstrap:仅返回 BUDGET_ADMIN(可登录的最小集),供选择器初始化。
    const admins = await prisma.user.findMany({
      where: { status: 'active', role: 'BUDGET_ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, role: true },
    });
    return NextResponse.json(admins);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
