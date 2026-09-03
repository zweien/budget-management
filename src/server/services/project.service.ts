import { Prisma, Project, User, MemberRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import {
  requirePermission,
  canEditProject,
  canWriteRecords as canWriteRecordsFn,
} from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';

/** 新建项目入参。ownerId 缺省时取操作者本人。 */
export interface CreateProjectInput {
  code: string;
  name: string;
  ownerId?: string;
  level?: string | null;
  projectType?: string | null;
  /** 预算类型(§包干制):GENERAL(默认)/ LUMP_SUM;非法值 422。 */
  budgetMode?: string | null;
  undertakingUnit?: string | null;
  /** 前端传 YYYY-MM-DD 日期串;服务端规范化为 Date(非法格式 422)。 */
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  remark?: string | null;
}

/** 更新项目入参。code 为系统内唯一标识,创建后不可改。 */
export interface UpdateProjectInput {
  name?: string;
  level?: string | null;
  projectType?: string | null;
  /** 预算类型切换:仅完全空白的项目允许(§切变锁定),否则 422。 */
  budgetMode?: string | null;
  undertakingUnit?: string | null;
  /** 前端传 YYYY-MM-DD 日期串;服务端规范化为 Date(非法格式 422)。 */
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  remark?: string | null;
}

/** 归一化预算类型入参:缺省 GENERAL;非法值 422(防 API 直调绕过表单枚举)。 */
export function normalizeBudgetMode(value: unknown): 'GENERAL' | 'LUMP_SUM' {
  if (value === undefined || value === null || value === '') return 'GENERAL';
  if (value === 'GENERAL' || value === 'LUMP_SUM') return value;
  throw new HTTPError(422, `预算类型无效:${String(value)}(应为 GENERAL 或 LUMP_SUM)`);
}

/**
 * §切变锁定(Q1b/Q8b):预算类型仅「完全空白」的项目可切换——
 * 无任何编制申请(含草稿)、无业务记录、无调整单、无到账登记。
 * 编制草稿已落库科目/年度预算数据,清理逻辑易出暗坑,草稿阶段即锁定。
 */
async function assertProjectBlankForModeSwitch(
  db: Prisma.TransactionClient | typeof prisma,
  projectId: string,
): Promise<void> {
  const [apps, records, adjustments, receipts] = await Promise.all([
    db.initialBudgetApplication.count({ where: { projectId } }),
    db.businessRecord.count({ where: { projectId } }),
    db.budgetAdjustment.count({ where: { projectId } }),
    db.receiptRecord.count({ where: { projectId } }),
  ]);
  if (apps > 0 || records > 0 || adjustments > 0 || receipts > 0) {
    throw new HTTPError(422, '项目已有预算编制(含草稿)/业务记录/调整单/到账登记,预算类型不可切换');
  }
}

/**
 * 起止日期入参规范化(§codex 修复):前端传 YYYY-MM-DD 日期串,而 Prisma 的
 * DateTime(@db.Date)要求完整 Date/ISO 值——裸日期串会导致 500。
 * 接受 Date / YYYY-MM-DD;非法格式返回 422(而非 Prisma 错误)。
 * 日历有效性回验(codex P2):JS 会把 2024-02-30 归一化为 03-01,
 * 构造结果须与分量一致才算合法日期,否则 422。
 */
function normalizeDateInput(value: Date | string | null | undefined, label: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (
        !Number.isNaN(dt.getTime()) &&
        dt.getUTCFullYear() === y &&
        dt.getUTCMonth() === mo - 1 &&
        dt.getUTCDate() === d
      ) {
        return dt;
      }
    }
  }
  throw new HTTPError(422, `${label}格式无效(应为合法日历日期 YYYY-MM-DD)`);
}

/** 起止顺序校验(两者都填时):结束不得早于开始(服务层强制,防 API 直调绕过表单)。 */
function assertDateOrder(startDate: Date | null, endDate: Date | null): void {
  if (startDate && endDate && endDate < startDate) {
    throw new HTTPError(422, '结束日期不能早于开始日期');
  }
}

/**
 * 新建项目(§16.1):仅管理员(project:create)→ 校验 code 系统内唯一 →
 * 事务内建 Project + ProjectBudget(初始/当前均为 0)
 * + 把 owner 加为 ProjectMember(OWNER 角色,获得该项目编辑权)+ 审计 create。code 冲突 → HTTPError 409。
 */
export async function createProject(
  input: CreateProjectInput,
  user: Pick<User, 'id' | 'role'>,
): Promise<Project> {
  await requirePermission(user, 'project:create');
  const ownerId = input.ownerId ?? user.id;
  const projectId = uuidv7();
  const startDate = normalizeDateInput(input.startDate, '开始日期');
  const endDate = normalizeDateInput(input.endDate, '结束日期');
  assertDateOrder(startDate, endDate);
  const budgetMode = normalizeBudgetMode(input.budgetMode);

  try {
    return await prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          id: projectId,
          code: input.code,
          name: input.name,
          level: input.level ?? null,
          projectType: input.projectType ?? null,
          budgetMode,
          undertakingUnit: input.undertakingUnit ?? null,
          startDate,
          endDate,
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
          budgetMode: project.budgetMode,
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
 * 列出项目。
 * v0.3.0 起普通用户全局只读 → 所有登录用户看到全部(未归档)项目;
 * 指定项目范围的凭证仅看到 allowlist 内项目(codex P1,列表语义=过滤而非拒绝);
 * 编辑权不在此处区分(由 canEditProject / requirePermission 在编辑动作上拦截)。
 */
export async function listProjects(
  user: {
    id: string;
    role: User['role'];
    viaApiKey?: boolean;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
  opts: { includeArchived?: boolean } = {},
): Promise<(Project & { canEdit: boolean })[]> {
  const scoped =
    user.viaApiKey && user.keyProjectScope === 'selected'
      ? { id: { in: user.keyProjectIds ?? [] } }
      : undefined;
  const projects = await prisma.project.findMany({
    where: scoped
      ? { ...scoped, ...(opts.includeArchived ? {} : { archivedAt: null }) }
      : opts.includeArchived
        ? undefined
        : { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    // 负责人展示取当前 OWNER 成员(§codex P2):成员管理可降级/移除原负责人,
    // Project.ownerId 不会随之回写,按 ownerId 展示会与实际编辑权漂移。
    include: {
      members: {
        where: { memberRole: 'OWNER' },
        select: { user: { select: { id: true, name: true } } },
      },
    },
  });
  // canEdit 随行下发(项目管理页编辑/归档按钮的行级门控):ADMIN 恒可,否则需 OWNER。
  if (user.role === 'ADMIN') {
    return projects.map((p) => ({ ...p, canEdit: true }));
  }
  const owned = await prisma.projectMember.findMany({
    where: { userId: user.id, memberRole: 'OWNER' },
    select: { projectId: true },
  });
  const ownedIds = new Set(owned.map((m) => m.projectId));
  return projects.map((p) => ({ ...p, canEdit: ownedIds.has(p.id) }));
}

/** 项目 + 当前用户权限标记(统一录入页的数据源)。 */
export interface ProjectWithPermissions {
  id: string;
  code: string;
  name: string;
  /** 预算/项目维护权(OWNER 或管理员)。 */
  canEdit: boolean;
  /** 业务记录录入权(OWNER/HANDLER 或管理员)。 */
  canWriteRecords: boolean;
}

/**
 * 列出全部(未归档)项目并附带当前用户的权限标记。
 * 查看本身全员开放;标记供统一录入页做项目选择与行级门控。
 * 指定项目范围的凭证仅返回 allowlist 内项目(codex P1)。
 */
export async function listProjectsWithPermissions(user: {
  id: string;
  role: User['role'];
  viaApiKey?: boolean;
  keyProjectScope?: string;
  keyProjectIds?: string[];
}): Promise<ProjectWithPermissions[]> {
  const scoped =
    user.viaApiKey && user.keyProjectScope === 'selected'
      ? { id: { in: user.keyProjectIds ?? [] } }
      : undefined;
  const projects = await prisma.project.findMany({
    where: scoped ? { ...scoped, archivedAt: null } : { archivedAt: null },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true },
  });
  if (user.role === 'ADMIN') {
    return projects.map((p) => ({ ...p, canEdit: true, canWriteRecords: true }));
  }
  const memberships = await prisma.projectMember.findMany({
    where: { userId: user.id },
    select: { projectId: true, memberRole: true },
  });
  const roleByProject = new Map(memberships.map((m) => [m.projectId, m.memberRole]));
  return projects.map((p) => {
    const role = roleByProject.get(p.id);
    return {
      ...p,
      canEdit: role === 'OWNER',
      canWriteRecords: role === 'OWNER' || role === 'HANDLER',
    };
  });
}

/** 取项目详情:先做 project:view 权限校验(含项目范围)。 */
export async function getProject(
  id: string,
  user: { id: string; role: User['role'] },
): Promise<Project & { canEdit: boolean; canWriteRecords: boolean }> {
  await requirePermission(user, 'project:view', id);
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      members: {
        where: { memberRole: 'OWNER' },
        select: { user: { select: { id: true, name: true } } },
      },
    },
  });
  if (!project) throw new HTTPError(404, '项目不存在');
  // 编辑权随详情下发,供前端门控:
  // canEdit=预算/项目维护(OWNER);canWriteRecords=业务记录录入(OWNER/HANDLER)。
  const [canEdit, canWriteRecords] = await Promise.all([
    canEditProject(user, id),
    canWriteRecordsFn(user, id),
  ]);
  // 归档项目只读:录入类写按钮全部隐藏(服务端 requirePermission 另有 409 兜底)。
  return { ...project, canEdit, canWriteRecords: canWriteRecords && !project.archivedAt };
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
  // 已归档项目不可编辑(§codex P2):归档=只读快照,须先恢复。
  if (before.archivedAt) {
    throw new HTTPError(409, '项目已归档,请先恢复后再编辑');
  }

  // 起止日期:规范化入参后按「生效后值」校验顺序(codex P2)——
  // 只改一个边界时,另一个沿用库中原值,合并后的有效对仍须满足 结束 ≥ 开始。
  const startDate =
    input.startDate !== undefined
      ? normalizeDateInput(input.startDate, '开始日期')
      : before.startDate;
  const endDate =
    input.endDate !== undefined ? normalizeDateInput(input.endDate, '结束日期') : before.endDate;
  assertDateOrder(startDate, endDate);

  const data: Prisma.ProjectUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.level !== undefined) data.level = input.level;
  if (input.projectType !== undefined) data.projectType = input.projectType;
  if (input.budgetMode !== undefined) {
    const mode = normalizeBudgetMode(input.budgetMode);
    // §切变锁定:仅在类型真的变化时校验空白,避免普通编辑被误拦。
    if (mode !== before.budgetMode) {
      await assertProjectBlankForModeSwitch(prisma, id);
    }
    data.budgetMode = mode;
  }
  if (input.undertakingUnit !== undefined) data.undertakingUnit = input.undertakingUnit;
  if (input.startDate !== undefined) data.startDate = startDate;
  if (input.endDate !== undefined) data.endDate = endDate;
  if (input.remark !== undefined) data.remark = input.remark;

  return prisma.$transaction(async (tx) => {
    const after = await tx.project.update({ where: { id }, data });
    await recordAudit(tx, {
      projectId: id,
      objectType: 'project',
      objectId: id,
      action: 'update',
      operatorId: user.id,
      // 快照覆盖全部可编辑字段(§codex P2):否则只改承担单位/日期时日志看不出变化。
      before: {
        name: before.name,
        level: before.level,
        projectType: before.projectType,
        budgetMode: before.budgetMode,
        undertakingUnit: before.undertakingUnit,
        startDate: before.startDate,
        endDate: before.endDate,
        remark: before.remark,
      },
      after: {
        name: after.name,
        level: after.level,
        projectType: after.projectType,
        budgetMode: after.budgetMode,
        undertakingUnit: after.undertakingUnit,
        startDate: after.startDate,
        endDate: after.endDate,
        remark: after.remark,
      },
    });
    return after;
  });
}

/** 恢复归档项目:清 archivedAt,审计(§issue 项目管理:误归档自助恢复)。 */
export async function unarchiveProject(
  id: string,
  user: { id: string; role: User['role'] },
): Promise<Project> {
  await requirePermission(user, 'project:edit', id);
  const before = await prisma.project.findUnique({ where: { id } });
  if (!before) throw new HTTPError(404, '项目不存在');

  return prisma.$transaction(async (tx) => {
    const after = await tx.project.update({
      where: { id },
      data: { archivedAt: null },
    });
    await recordAudit(tx, {
      projectId: id,
      objectType: 'project',
      objectId: id,
      action: 'unarchive',
      operatorId: user.id,
      before: { archivedAt: before.archivedAt },
      after: { archivedAt: after.archivedAt },
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
