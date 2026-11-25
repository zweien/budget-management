import { NextRequest, NextResponse } from 'next/server';

import { readJson, withRoute } from '@/lib/api/withRoute';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { reorderMembers } from '@/server/services/member.service';

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/projects/[id]/members/order — 调整成员顺序(仅 ADMIN)。
 * body = { order: userId[] }:全量顺序,按数组下标写 sortOrder;
 * 第一负责人 = 顺序最前的 OWNER(调整表「项目负责人」与概览显示口径)。
 */
export const PUT = withRoute(async (req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = (await readJson(req).catch(() => null)) as { order?: unknown } | null;
  if (!body || !Array.isArray(body.order) || body.order.some((v) => typeof v !== 'string')) {
    throw new HTTPError(422, 'order 须为 userId 字符串数组');
  }
  const members = await reorderMembers(id, body.order as string[], user);
  return NextResponse.json(members);
});
