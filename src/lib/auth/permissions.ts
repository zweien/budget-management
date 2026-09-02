import { User, UserRole, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { HTTPError } from '@/lib/auth/session';

/**
 * 权限动作(v0.3.0 重构)。
 * 全局角色只有两级:ADMIN(全部)/ USER(全局只读)。
 * 项目编辑权不看全局角色,看 ProjectMember(OWNER)——见 requirePermission 第二步。
 */
export type Action =
  | 'project:view' // 查看项目(台账/记录/统计等;所有登录用户,全项目可见)
  | 'project:create' // 新建项目(仅管理员)
  | 'project:edit' // 维护项目基础信息/归档(管理员或该项目 OWNER 成员)
  | 'budget:editInitial' // 编制初始预算
  | 'budget:editSubjectTree' // 维护初始科目树
  | 'budget:adjust' // 发起预算调整
  | 'budget:changeSubject' // 发起科目变更
  | 'budget:approve' // 审批(编制/调整/科目变更;仅管理员)
  | 'record:create' // 新增业务记录
  | 'record:edit' // 修改业务记录
  | 'record:void' // 作废业务记录
  | 'record:import' // Excel 导入
  | 'audit:view' // 查看操作审计(所有登录用户)
  | 'user:list' // 列出全部用户(仅管理员;成员管理选择器数据源)
  | 'member:manage'; // 管理项目成员/设定负责人(仅管理员)

/** 仅 OWNER 成员可执行的项目级编辑动作(预算/项目维护类;管理员豁免)。 */
const OWNER_EDIT_ACTIONS = new Set<Action>([
  'project:edit',
  'budget:editInitial',
  'budget:editSubjectTree',
  'budget:adjust',
  'budget:changeSubject',
  'record:import',
  // 作废是破坏性操作,归 OWNER/ADMIN(与 AGENTS.md「HANDLER=只读成员」一致)。
  'record:void',
]);

/** 业务记录写动作:OWNER 与 HANDLER 成员均可(录入人员=HANDLER;管理员豁免)。 */
const RECORD_WRITE_ACTIONS = new Set<Action>(['record:create', 'record:edit']);

/** 兼容旧引用:全部项目级编辑动作(OWNER_EDIT ∪ RECORD_WRITE)。 */
const EDIT_ACTIONS = new Set<Action>([...OWNER_EDIT_ACTIONS, ...RECORD_WRITE_ACTIONS]);

const ADMIN_ACTIONS = new Set<Action>([
  'project:view',
  'project:create',
  'project:edit',
  'budget:editInitial',
  'budget:editSubjectTree',
  'budget:adjust',
  'budget:changeSubject',
  'budget:approve',
  'record:create',
  'record:edit',
  'record:void',
  'record:import',
  'audit:view',
  'user:list',
  'member:manage',
]);

/** 普通用户:全局只读(查看/审计),无任何编辑动作。 */
const USER_ACTIONS = new Set<Action>(['project:view', 'audit:view']);

const MATRIX: Record<UserRole, Set<Action>> = {
  ADMIN: ADMIN_ACTIONS,
  USER: USER_ACTIONS,
};

/**
 * 无人值守(机器凭证)硬排除动作:不可逆/审批/权限管理类(ADR 0001、AGENTS.md「确认策略」)。
 * unattended 凭证触碰时服务端直接 403 并写入被拒审计——不是「不建议」而是「做不了」;
 * 在场交互可用 attended 凭证(`make-agent --attended`)或正常登录会话执行。
 */
export const UNATTENDED_EXCLUDED_ACTIONS = new Set<Action>([
  'record:void', // 作废(单条/批量)不可逆
  'budget:approve', // 审批:初始预算/预算调整/科目变更的通过与驳回
  'member:manage', // 项目成员与权限变更
]);

/** 凭证档位「只读」允许的动作(查询/统计/审计;项目范围收窄仍生效)。 */
const KEY_READ_ACTIONS = new Set<Action>(['project:view', 'audit:view', 'user:list']);

/** 凭证档位「读写」在只读之上追加的动作(业务记录、导入、到账)。 */
const KEY_WRITE_ACTIONS = new Set<Action>(['record:create', 'record:edit', 'record:import']);

/** scope 收窄拒绝(档位/项目范围);返回错误消息,null=放行。scope 只砍不加:
 *  实际权限 = 用户权限 ∩ 凭证范围,矩阵仍是唯一真相源。 */
function apiKeyScopeDenial(
  scopes: {
    viaApiKey?: boolean;
    keyTier?: string;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
  action: Action,
  projectId?: string,
): string | null {
  if (!scopes.viaApiKey) return null;
  const tier = scopes.keyTier ?? 'full';
  if (tier === 'read' && !KEY_READ_ACTIONS.has(action)) {
    return '凭证档位为只读,禁止此操作';
  }
  if (tier === 'write' && !KEY_READ_ACTIONS.has(action) && !KEY_WRITE_ACTIONS.has(action)) {
    return '凭证档位为读写,禁止预算/项目维护类操作(请使用完整档凭证或登录会话)';
  }
  if (
    (scopes.keyProjectScope ?? 'all') === 'selected' &&
    projectId &&
    !(scopes.keyProjectIds ?? []).includes(projectId)
  ) {
    return '凭证未授权访问该项目';
  }
  // selected-scope 且无项目上下文:除列表类(project:view,由 service 过滤到 allowlist)
  // 外一律拒绝,防止跨项目聚合/管理接口(统计/审计/建项目/用户列表)绕过范围。
  if ((scopes.keyProjectScope ?? 'all') === 'selected' && !projectId && action !== 'project:view') {
    return '指定项目范围的凭证禁止执行跨项目操作(请携带 projectId)';
  }
  return null;
}

/**
 * 跨项目/无项目上下文接口的 scope 门卫:指定项目范围的凭证一律 403。
 * 用于不经 requirePermission 的聚合接口(审计日志、审批待办、用户列表、
 * 无 projectId 的统计/导出);项目列表类接口不走此门卫,由 service 过滤到 allowlist。
 */
export function denyApiKeyCrossProject(
  user: Pick<User, 'id' | 'role'> & {
    viaApiKey?: boolean;
    keyProjectScope?: string;
  },
): void {
  if (user.viaApiKey && (user.keyProjectScope ?? 'all') === 'selected') {
    throw new HTTPError(403, '指定项目范围的凭证禁止访问跨项目接口');
  }
}

/** 机器凭证被拒审计:operator=凭证所属用户,失败不掩盖随后的 403。
 *  projectId 仅在真实存在时落库(外键约束);否则置 null,原始值进 afterData。 */
async function auditMachineDenied(
  user: { id: string; apiKeyPrefix?: string },
  action: Action,
  projectId: string | undefined,
  auditAction: 'unattended.denied' | 'apikey.denied',
  extra: Prisma.InputJsonObject = {},
): Promise<void> {
  const validProjectId = projectId
    ? ((
        await prisma.project
          .findUnique({ where: { id: projectId }, select: { id: true } })
          .catch(() => null)
      )?.id ?? null)
    : null;
  await prisma.auditLog
    .create({
      data: {
        id: uuidv7(),
        projectId: validProjectId,
        objectType: 'permission',
        objectId: projectId ?? user.id,
        action: auditAction,
        afterData: {
          attemptedAction: action,
          apiKeyPrefix: user.apiKeyPrefix ?? null,
          ...(projectId && !validProjectId ? { attemptedProjectId: projectId } : {}),
          ...extra,
        },
        operatorId: user.id,
      },
    })
    .catch(() => {});
}

/** 是否有某动作权限(仅按全局角色,不含项目成员维度) */
export function can(user: { role: UserRole }, action: Action): boolean {
  return MATRIX[user.role]?.has(action) ?? false;
}

/** 编辑类动作判定(供 UI/服务端判断"是否需要项目 OWNER"前置)。 */
export function isEditAction(action: Action): boolean {
  return EDIT_ACTIONS.has(action);
}

/**
 * 用户在某项目上是否有编辑权(预算/项目维护):管理员恒真;否则需该项目 OWNER 成员。
 * UI 门控与服务端 requirePermission 共用同一真相源。
 */
export async function canEditProject(
  user: { id: string; role: UserRole },
  projectId: string,
): Promise<boolean> {
  if (user.role === 'ADMIN') return true;
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { memberRole: true },
  });
  return member?.memberRole === 'OWNER';
}

/**
 * 用户在某项目上是否可录入/维护业务记录:管理员恒真;
 * 否则需该项目 OWNER 或 HANDLER 成员(HANDLER=录入人员)。
 */
export async function canWriteRecords(
  user: { id: string; role: UserRole },
  projectId: string,
): Promise<boolean> {
  if (user.role === 'ADMIN') return true;
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { memberRole: true },
  });
  return member?.memberRole === 'OWNER' || member?.memberRole === 'HANDLER';
}

/**
 * 要求用户具备某动作权限:
 *  - 预算/项目维护类(OWNER_EDIT_ACTIONS):管理员 或 该项目 OWNER 成员。
 *  - 业务记录写动作(RECORD_WRITE_ACTIONS):管理员 或 该项目 OWNER/HANDLER 成员。
 *  - 其余动作:全局角色矩阵校验(查看类 USER 也有;审批/管理类仅 ADMIN)。
 * 项目级动作均须携带 projectId。服务端权限再校验(§15.3)。
 */
export async function requirePermission(
  user: {
    id: string;
    role: UserRole;
    viaApiKey?: boolean;
    unattended?: boolean;
    apiKeyPrefix?: string;
    keyTier?: string;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
  action: Action,
  projectId?: string,
): Promise<void> {
  // 无人值守凭证硬排除(与项目状态无关,置于一切分支之前)。
  if (user.unattended && UNATTENDED_EXCLUDED_ACTIONS.has(action)) {
    await auditMachineDenied(user, action, projectId, 'unattended.denied');
    throw new HTTPError(403, '无人值守凭证禁止执行此操作(作废/审批/成员管理仅限人在场会话)');
  }
  // 凭证 scope 收窄(档位/项目范围;只砍不加,置于成员/矩阵判定之前,命中即拒)。
  const scopeDenial = apiKeyScopeDenial(user, action, projectId);
  if (scopeDenial) {
    await auditMachineDenied(user, action, projectId, 'apikey.denied', {
      reason: scopeDenial,
      keyTier: user.keyTier ?? 'full',
      keyProjectScope: user.keyProjectScope ?? 'all',
    });
    throw new HTTPError(403, scopeDenial);
  }
  // 归档项目只读(§codex P1):除豁免动作外,一切项目写动作在归档期间拒绝。
  // 前置执行(OWNER_EDIT/RECORD_WRITE 分支内有提前 return,放后面会被绕过)。
  // 豁免:查看、project:edit(恢复归档本身依赖它;updateProject 另有自己的 409)、
  // 成员管理(项目行政事务)。project:view 不查询,读路径零额外开销。
  if (
    projectId &&
    action !== 'project:view' &&
    action !== 'project:edit' &&
    action !== 'member:manage'
  ) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { archivedAt: true },
    });
    if (project?.archivedAt) {
      throw new HTTPError(409, '项目已归档,数据只读;恢复后才能执行此操作');
    }
  }
  if (OWNER_EDIT_ACTIONS.has(action)) {
    if (!projectId) {
      throw new HTTPError(403, `操作 ${action} 需要指定项目`);
    }
    if (!(await canEditProject(user, projectId))) {
      throw new HTTPError(403, '仅项目负责人在该项目内可执行此操作');
    }
    return;
  }
  if (RECORD_WRITE_ACTIONS.has(action)) {
    if (!projectId) {
      throw new HTTPError(403, `操作 ${action} 需要指定项目`);
    }
    if (!(await canWriteRecords(user, projectId))) {
      throw new HTTPError(403, '仅项目成员(负责人/录入成员)在该项目内可执行此操作');
    }
    return;
  }
  if (!can(user, action)) {
    throw new HTTPError(403, `无权限执行操作:${action}`);
  }
}
