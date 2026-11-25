import { MemberRole, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';

/**
 * 项目成员管理(§2 角色模型 v0.3.0)。
 * 项目编辑权完全由成员表驱动:OWNER=可编辑,HANDLER=只读成员(历史语义降级)。
 * 全部写操作仅 ADMIN(member:manage);全部操作写审计日志。
 */

export interface MemberView {
  userId: string;
  name: string;
  memberRole: MemberRole;
  authorizedAt: Date;
}

/** 列出项目成员(查看权限即可;成员管理卡片的数据源)。按成员顺序返回(第一负责人在前)。 */
export async function listMembers(
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<MemberView[]> {
  await requirePermission(user, 'project:view', projectId);
  const rows = await prisma.projectMember.findMany({
    where: { projectId },
    include: { user: { select: { id: true, name: true } } },
    orderBy: [{ sortOrder: 'asc' }, { authorizedAt: 'asc' }],
  });
  return rows.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    memberRole: r.memberRole,
    authorizedAt: r.authorizedAt,
  }));
}

/** 添加成员(仅 ADMIN)。已存在则 409;目标用户不存在/停用则 422。 */
export async function addMember(
  projectId: string,
  input: { userId: string; memberRole: MemberRole },
  user: Pick<User, 'id' | 'role'>,
): Promise<MemberView> {
  await requirePermission(user, 'member:manage', projectId);
  if (!Object.values(MemberRole).includes(input.memberRole)) {
    throw new HTTPError(422, `非法成员角色:${input.memberRole}`);
  }

  const target = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!target || target.status !== 'active') {
    throw new HTTPError(422, '目标用户不存在或已停用');
  }
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new HTTPError(404, '项目不存在');

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: input.userId } },
  });
  if (existing) {
    throw new HTTPError(409, '该用户已是项目成员(如需变更角色请用修改)');
  }

  return prisma.$transaction(async (tx) => {
    // 新成员追加到顺序末尾(不打乱既有第一负责人口径)。
    const last = await tx.projectMember.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });
    const created = await tx.projectMember.create({
      data: {
        id: uuidv7(),
        projectId,
        userId: input.userId,
        memberRole: input.memberRole,
        sortOrder: (last._max.sortOrder ?? 0) + 1,
      },
    });
    await recordAudit(tx, {
      projectId,
      objectType: 'project_members',
      objectId: created.id,
      action: 'create',
      operatorId: user.id,
      after: { userId: target.id, name: target.name, memberRole: created.memberRole },
    });
    return {
      userId: target.id,
      name: target.name,
      memberRole: created.memberRole,
      authorizedAt: created.authorizedAt,
    };
  });
}

/** 修改成员角色(仅 ADMIN)。 */
export async function updateMemberRole(
  projectId: string,
  targetUserId: string,
  memberRole: MemberRole,
  user: Pick<User, 'id' | 'role'>,
): Promise<MemberView> {
  await requirePermission(user, 'member:manage', projectId);
  if (!Object.values(MemberRole).includes(memberRole)) {
    throw new HTTPError(422, `非法成员角色:${memberRole}`);
  }
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    include: { user: { select: { name: true } } },
  });
  if (!existing) throw new HTTPError(404, '该用户不是项目成员');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.projectMember.update({
      where: { projectId_userId: { projectId, userId: targetUserId } },
      // 角色变更 = 重新授权,刷新授权时间(重新授权的记录语义;排序已由
      // sortOrder 驱动,authorizedAt 不再影响第一负责人的取值)。
      data: {
        memberRole,
        ...(existing.memberRole !== memberRole ? { authorizedAt: new Date() } : {}),
      },
    });
    await recordAudit(tx, {
      projectId,
      objectType: 'project_members',
      objectId: existing.id,
      action: 'update',
      operatorId: user.id,
      before: { userId: targetUserId, name: existing.user.name, memberRole: existing.memberRole },
      after: { userId: targetUserId, name: existing.user.name, memberRole: updated.memberRole },
    });
    return {
      userId: targetUserId,
      name: existing.user.name,
      memberRole: updated.memberRole,
      authorizedAt: updated.authorizedAt,
    };
  });
}

/** 移除成员(仅 ADMIN)。 */
export async function removeMember(
  projectId: string,
  targetUserId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
  await requirePermission(user, 'member:manage', projectId);
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    include: { user: { select: { name: true } } },
  });
  if (!existing) throw new HTTPError(404, '该用户不是项目成员');

  return prisma.$transaction(async (tx) => {
    await tx.projectMember.delete({
      where: { projectId_userId: { projectId, userId: targetUserId } },
    });
    await recordAudit(tx, {
      projectId,
      objectType: 'project_members',
      objectId: existing.id,
      action: 'delete',
      operatorId: user.id,
      before: { userId: targetUserId, name: existing.user.name, memberRole: existing.memberRole },
    });
  });
}

/**
 * 调整成员顺序(仅 ADMIN):body 传全量 userId 顺序,按数组下标写 sortOrder。
 * 第一负责人 = 顺序最前的 OWNER——调整表「项目负责人」与概览/列表负责人显示
 * 均按此口径;order 必须与现有成员不重不漏,否则 422。
 */
export async function reorderMembers(
  projectId: string,
  orderedUserIds: string[],
  user: Pick<User, 'id' | 'role'>,
): Promise<MemberView[]> {
  await requirePermission(user, 'member:manage', projectId);
  if (!Array.isArray(orderedUserIds)) {
    throw new HTTPError(422, 'order 须为 userId 数组');
  }
  const rows = await prisma.projectMember.findMany({
    where: { projectId },
    include: { user: { select: { id: true, name: true } } },
    orderBy: [{ sortOrder: 'asc' }, { authorizedAt: 'asc' }],
  });
  if (new Set(orderedUserIds).size !== orderedUserIds.length) {
    throw new HTTPError(422, 'order 不得包含重复成员');
  }
  if (orderedUserIds.length !== rows.length) {
    throw new HTTPError(422, 'order 必须包含全部项目成员,不重不漏');
  }
  const known = new Set(rows.map((r) => r.userId));
  for (const uid of orderedUserIds) {
    if (!known.has(uid)) throw new HTTPError(422, 'order 包含非项目成员的用户');
  }
  if (rows.length === 0) return [];

  const beforeOrder = rows.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    memberRole: r.memberRole,
  }));
  const updated = await prisma.$transaction(async (tx) => {
    for (const [index, uid] of orderedUserIds.entries()) {
      await tx.projectMember.update({
        where: { projectId_userId: { projectId, userId: uid } },
        data: { sortOrder: index + 1 },
      });
    }
    const after = await tx.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: [{ sortOrder: 'asc' }, { authorizedAt: 'asc' }],
    });
    await recordAudit(tx, {
      projectId,
      objectType: 'project_members',
      objectId: projectId,
      action: 'reorder',
      operatorId: user.id,
      before: { order: beforeOrder },
      after: {
        order: after.map((r) => ({
          userId: r.userId,
          name: r.user.name,
          memberRole: r.memberRole,
        })),
      },
    });
    return after;
  });
  return updated.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    memberRole: r.memberRole,
    authorizedAt: r.authorizedAt,
  }));
}
