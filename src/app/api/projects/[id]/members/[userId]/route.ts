import { NextRequest, NextResponse } from 'next/server';

import { MemberRole } from '@prisma/client';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { removeMember, updateMemberRole } from '@/server/services/member.service';

type Ctx = { params: Promise<{ id: string; userId: string }> };

/**
 * PATCH /api/projects/[id]/members/[userId] — 变更成员角色(仅 ADMIN)。
 * DELETE — 移除成员(仅 ADMIN)。
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id, userId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { memberRole?: string } | null;
    if (!body?.memberRole) {
      throw new HTTPError(400, '缺少必填字段:memberRole');
    }
    const member = await updateMemberRole(id, userId, body.memberRole as MemberRole, user);
    return NextResponse.json(member);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id, userId } = await ctx.params;
    await removeMember(id, userId, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
