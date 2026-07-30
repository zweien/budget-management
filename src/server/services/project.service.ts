import { Prisma, Project, User, MemberRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { getAccessibleProjectIds } from '@/lib/auth/projects';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';

/** 新建项目入参。ownerId 缺省时取操作者本人。 */
export interface CreateProjectInput {
  code: string;
  name: string;
  ownerId?: string;
  level?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  remark?: string | null;
}

/** 更新项目入参。code 为系统内唯一标识,创建后不可改。 */
export interface UpdateProjectInput {
  name?: string;
  level?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  remark?: string | null;
}

/**
 * 新建项目(§16.1):校验 code 系统内唯一 → 事务内建 Project + ProjectBudget(初始/当前均为 0)
 * + 把 owner 加为 ProjectMember(OWNER 角色)+ 审计 create。code 冲突 → HTTPError 409。
 */
export async function createProject(
  input: CreateProjectInput,
  user: Pick<User, 'id'>,
): Promise<Project> {
  const ownerId = input.ownerId ?? user.id;
  const projectId = uuidv7();

  try {
    return await prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          id: projectId,
          code: input.code,
          name: input.name,
          level: input.level ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          ownerId,
          remark: input.remark ?? null,
        },
      });

      // 初始预算:初始/调整/当前均为 0(编制审批生效后才回填)。
      await tx.projectBudget.create({
        data: {
          projectId: project.id,
          initialAmount: new Prisma.Decimal(0),
          adjustmentAmount: new Prisma.Decimal(0),
          currentAmount: new Prisma.Decimal(0),
        },
      });

      // 把 owner 加为项目成员(OWNER 角色)。
      await tx.projectMember.create({
        data: {
          id: uuidv7(),
          projectId: project.id,
          userId: ownerId,
          memberRole: MemberRole.OWNER,
        },
      });

      await recordAudit(tx, {
        projectId: project.id,
        objectType: 'project',
        objectId: project.id,
        action: 'create',
        operatorId: user.id,
        after: {
          code: project.code,
          name: project.name,
          ownerId: project.ownerId,
        },
      });

      return project;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new HTTPError(409, `项目编码已存在:${input.code}`);
    }
    throw e;
  }
}

/**
 * 列出项目:预算管理员看全部;其余角色按 getAccessibleProjectIds 过滤。
 */
export async function listProjects(user: { id: string; role: User['role'] }): Promise<Project[]> {
  if (user.role === 'BUDGET_ADMIN') {
    return prisma.project.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }
  const ids = await getAccessibleProjectIds(user);
  if (ids.length === 0) return [];
  return prisma.project.findMany({
    where: { id: { in: ids }, archivedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

/** 取项目详情:先做 project:view 权限校验(含项目范围)。 */
export async function getProject(
  id: string,
  user: { id: string; role: User['role'] },
): Promise<Project> {
  await requirePermission(user, 'project:view', id);
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) throw new HTTPError(404, '项目不存在');
  return project;
}

/** 更新项目:权限校验后更新可改字段并审计。 */
export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  user: { id: string; role: User['role'] },
): Promise<Project> {
  await requirePermission(user, 'project:edit', id);
  const before = await prisma.project.findUnique({ where: { id } });
  if (!before) throw new HTTPError(404, '项目不存在');

  const data: Prisma.ProjectUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.level !== undefined) data.level = input.level;
  if (input.startDate !== undefined) data.startDate = input.startDate;
  if (input.endDate !== undefined) data.endDate = input.endDate;
  if (input.remark !== undefined) data.remark = input.remark;

  return prisma.$transaction(async (tx) => {
    const after = await tx.project.update({ where: { id }, data });
    await recordAudit(tx, {
      projectId: id,
      objectType: 'project',
      objectId: id,
      action: 'update',
      operatorId: user.id,
      before: {
        name: before.name,
        level: before.level,
        remark: before.remark,
      },
      after: {
        name: after.name,
        level: after.level,
        remark: after.remark,
      },
    });
    return after;
  });
}

/** 归档项目:置 archivedAt,审计。 */
export async function archiveProject(
  id: string,
  user: { id: string; role: User['role'] },
): Promise<Project> {
  await requirePermission(user, 'project:edit', id);
  const before = await prisma.project.findUnique({ where: { id } });
  if (!before) throw new HTTPError(404, '项目不存在');

  return prisma.$transaction(async (tx) => {
    const after = await tx.project.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await recordAudit(tx, {
      projectId: id,
      objectType: 'project',
      objectId: id,
      action: 'archive',
      operatorId: user.id,
      before: { archivedAt: before.archivedAt },
      after: { archivedAt: after.archivedAt },
    });
    return after;
  });
}
