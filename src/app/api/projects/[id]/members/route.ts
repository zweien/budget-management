import { NextRequest, NextResponse } from 'next/server';

import { MemberRole } from '@prisma/client';

import { withRoute } from '@/lib/api/withRoute';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { addMember, listMembers } from '@/server/services/member.service';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/members — 成员列表(项目可见即可查)。
 * POST — 添加成员(仅 ADMIN;memberRole: OWNER|HANDLER)。
 */
export const GET = withRoute(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const members = await listMembers(id, user);
  return NextResponse.json(members);
});

export const POST = withRoute(async (req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    userId?: string;
    memberRole?: string;
  } | null;
  if (!body?.userId || !body?.memberRole) {
    throw new HTTPError(400, '缺少必填字段:userId / memberRole');
  }
  const member = await addMember(
    id,
    { userId: body.userId, memberRole: body.memberRole as MemberRole },
    user,
  );
  return NextResponse.json(member, { status: 201 });
});
