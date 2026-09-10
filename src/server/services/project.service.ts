import { Prisma, Project, User, MemberRole } from '@prisma/client';

import { prisma, BULK_TX_OPTIONS } from '@/lib/prisma';
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
 *
 * 序列化契约(§codex P2 review):本检查必须在**锁住项目行的事务内**执行;
 * 创建入口 initialBudget.createDraft / adjustment.createAdjustment /
 * receipt.createReceipt 的事务同样先锁项目行,与之串行化。业务记录/导入
 * 依赖叶科目外键 → 传递性依赖已提交的编制草稿(持锁),无需自带锁。
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
      // 项目管理列表展示总经费(当前口径);未编制初始预算的项目该行为 null。
      projectBudget: true,
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
    // §切变锁定:仅在类型真的变化时校验空白,避免普通编辑被误拦(检查在下方事务内做)。
    if (mode !== before.budgetMode) {
      data.budgetMode = mode;
    }
  }
  if (input.undertakingUnit !== undefined) data.undertakingUnit = input.undertakingUnit;
  if (input.startDate !== undefined) data.startDate = startDate;
  if (input.endDate !== undefined) data.endDate = endDate;
  if (input.remark !== undefined) data.remark = input.remark;
  const switchingMode = data.budgetMode !== undefined;

  return prisma.$transaction(async (tx) => {
    if (switchingMode) {
      // §codex P2 review:切换先锁项目行再查空白——与持同一把锁的创建入口
      // (编制草稿/调整单/业务记录/到账)串行化,杜绝「切换读到空项目 →
      // 并发创建提交 → 切换后项目非空」的竞态窗口。
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${id}::uuid FOR UPDATE`;
      await assertProjectBlankForModeSwitch(tx, id);
    }
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

// ---------------- 彻底删除已归档项目 ----------------

/** purge 类接口的调用者(requireUser() 结果携带凭证标记)。 */
type PurgeActor = { id: string; role: User['role'] } & {
  viaApiKey?: boolean;
  unattended?: boolean;
  apiKeyPrefix?: string;
  keyTier?: string;
  keyProjectScope?: string;
  keyProjectIds?: string[];
};

/** 删除预览:确认弹窗展示的数据量与金额(§彻底删除裁决 Q4:不设门槛,数字亮出来)。 */
export interface ProjectPurgePreview {
  projectId: string;
  code: string;
  name: string;
  archivedAt: string;
  recordCount: number;
  voidRecordCount: number;
  attachmentCount: number;
  receiptCount: number;
  importBatchCount: number;
  memberCount: number;
  paidAmount: string;
  totalOccupied: string;
}

/** 会话红线:仅管理员登录会话(对齐凭证管理/用户管理红线,拒绝一切机器凭证)。 */
function assertPurgeSession(user: PurgeActor): void {
  if (user.viaApiKey) {
    throw new HTTPError(403, '彻底删除项目仅限管理员登录会话使用,机器凭证不得调用');
  }
  if (user.role !== 'ADMIN') {
    throw new HTTPError(403, '仅管理员可彻底删除项目');
  }
}

/** purge 共用前置:project:delete 矩阵(无人值守凭证在此路径落 unattended.denied 审计)
 *  → 会话红线(拒绝一切机器凭证,含 attended)→ 仅已归档。 */
async function loadPurgeTarget(
  id: string,
  actor: PurgeActor,
): Promise<Project & { archivedAt: Date }> {
  await requirePermission(actor, 'project:delete', id);
  assertPurgeSession(actor);
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) throw new HTTPError(404, '项目不存在');
  if (!project.archivedAt) throw new HTTPError(409, '仅已归档项目可彻底删除;请先归档');
  return project as Project & { archivedAt: Date };
}

/** 汇总删除范围内的数据量与金额。 */
async function buildPurgePreview(
  project: Project & { archivedAt: Date },
): Promise<ProjectPurgePreview> {
  const [allAgg, voidAgg, paidAgg, attachmentCount, receiptCount, importBatchCount, memberCount] =
    await Promise.all([
      prisma.businessRecord.aggregate({
        where: { projectId: project.id },
        _count: { id: true },
      }),
      prisma.businessRecord.aggregate({
        where: { projectId: project.id, isVoid: true },
        _count: { id: true },
      }),
      prisma.businessRecord.aggregate({
        where: { projectId: project.id, isVoid: false, status: 'PAID' },
        _sum: { amount: true },
      }),
      prisma.recordAttachment.count({ where: { record: { projectId: project.id } } }),
      prisma.receiptRecord.count({ where: { projectId: project.id } }),
      prisma.importBatch.count({ where: { projectId: project.id } }),
      prisma.projectMember.count({ where: { projectId: project.id } }),
    ]);
  const occupiedAgg = await prisma.businessRecord.aggregate({
    where: { projectId: project.id, isVoid: false },
    _sum: { amount: true },
  });

  return {
    projectId: project.id,
    code: project.code,
    name: project.name,
    archivedAt: project.archivedAt.toISOString(),
    recordCount: allAgg._count.id,
    voidRecordCount: voidAgg._count.id,
    attachmentCount,
    receiptCount,
    importBatchCount,
    memberCount,
    paidAmount: paidAgg._sum.amount?.toFixed(2) ?? '0.00',
    totalOccupied: occupiedAgg._sum.amount?.toFixed(2) ?? '0.00',
  };
}

/** GET 前瞻:删除预览(不落任何变更)。 */
export async function getPurgePreview(id: string, actor: PurgeActor): Promise<ProjectPurgePreview> {
  const project = await loadPurgeTarget(id, actor);
  return buildPurgePreview(project);
}

/**
 * 彻底删除已归档项目:单事务内按依赖顺序清空全部子数据 + 项目行。
 *
 * 前置:project:delete(仅 ADMIN)+ 管理员登录会话(机器凭证一律 403)+
 * 已归档 + confirmCode 与项目编号一致(服务端强校验,不能只靠前端状态)。
 * 不可逆:业务记录/科目树/各层预算/调整/科目变更/初始预算申请/到账/导入批次/
 * 成员全部物理删除;audit_logs.projectId 随项目删除被 FK SetNull(行保留,快照可追溯);
 * approval_logs 为多态引用,按「审计类只增不删」原则保留。
 */
export async function purgeArchivedProject(
  id: string,
  actor: PurgeActor,
  confirmCode: string | undefined,
): Promise<ProjectPurgePreview> {
  const project = await loadPurgeTarget(id, actor);
  // 确认编号双侧归一化比对(codex P2):建项目入口未 trim 编号,若只 trim 输入侧,
  // 库内带空白的编号将永远无法通过确认。
  if (!confirmCode || confirmCode.trim() !== project.code.trim()) {
    throw new HTTPError(422, '项目编号确认不一致;请在确认弹窗中输入项目编号后再执行彻底删除');
  }
  const preview = await buildPurgePreview(project);
  const purgedAt = new Date();

  await prisma.$transaction(async (tx) => {
    // 事务内锁行并复核归档态(codex P1):预览/校验与删除之间存在「取消归档」竞态窗口,
    // 以删除事务内的锁定读为准,防止误删已恢复为活跃的项目。
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${id}::uuid FOR UPDATE`;
    const fresh = await tx.project.findUnique({
      where: { id },
      select: { archivedAt: true },
    });
    if (!fresh?.archivedAt) {
      throw new HTTPError(409, '项目已恢复为活跃状态,本次彻底删除已取消');
    }
    // FK 全库默认 Restrict(仅附件随记录 Cascade),按依赖顺序清表:
    // 记录域 → 调整域 → 申请域 → 预算层 → 导入域 → 科目/到账 → 成员 → 项目。
    await tx.businessRecordHistory.deleteMany({
      where: { businessRecord: { projectId: id } },
    });
    await tx.businessRecord.deleteMany({ where: { projectId: id } });
    await tx.budgetAdjustmentLine.deleteMany({ where: { adjustment: { projectId: id } } });
    await tx.budgetLock.deleteMany({ where: { projectId: id } });
    await tx.budgetAdjustment.deleteMany({ where: { projectId: id } });
    await tx.subjectChangeApplication.deleteMany({ where: { projectId: id } });
    await tx.initialBudgetApplication.deleteMany({ where: { projectId: id } });
    await tx.subjectTotalBudget.deleteMany({ where: { projectId: id } });
    await tx.subjectBudget.deleteMany({ where: { projectId: id } });
    await tx.annualBudget.deleteMany({ where: { projectId: id } });
    await tx.projectBudget.deleteMany({ where: { projectId: id } });
    await tx.importRow.deleteMany({ where: { batch: { projectId: id } } });
    await tx.importBatch.deleteMany({ where: { projectId: id } });
    await tx.budgetSubject.deleteMany({ where: { projectId: id } });
    await tx.receiptRecord.deleteMany({ where: { projectId: id } });
    await tx.projectMember.deleteMany({ where: { projectId: id } });
    // 删除动作留痕:必须在 project.delete 之前落行(FK 指向仍存在的项目);
    // 随后的删除经 ON DELETE SET NULL 把该行 projectId 自动置空,行本身保留可追溯。
    await recordAudit(tx, {
      projectId: id,
      objectType: 'project',
      objectId: id,
      action: 'purge',
      operatorId: actor.id,
      before: {
        code: project.code,
        name: project.name,
        archivedAt: project.archivedAt.toISOString(),
        recordCount: preview.recordCount,
        attachmentCount: preview.attachmentCount,
        receiptCount: preview.receiptCount,
        paidAmount: preview.paidAmount,
        totalOccupied: preview.totalOccupied,
      },
      after: { purgedAt: purgedAt.toISOString() },
    });
    await tx.project.delete({ where: { id } });
  }, BULK_TX_OPTIONS);
  return preview;
}
