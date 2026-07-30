import { UserRole } from '@prisma/client';
import { getAccessibleProjectIds } from './projects';
import { HTTPError } from '@/lib/auth/session';

// §2.2 权限矩阵的动作
export type Action =
  | 'project:view' // 查看获授权项目
  | 'project:viewAll' // 查看全部项目(仅管理员)
  | 'project:edit' // 维护项目基础信息/归档(owner/handler/admin 均可)
  | 'budget:editInitial' // 编制初始预算
  | 'budget:editSubjectTree' // 维护初始科目树
  | 'budget:adjust' // 发起预算调整
  | 'budget:changeSubject' // 发起科目变更
  | 'budget:approve' // 审批(编制/调整/科目变更)
  | 'record:create' // 新增业务记录
  | 'record:edit' // 修改业务记录
  | 'record:void' // 作废业务记录
  | 'record:import' // Excel 导入
  | 'audit:view'; // 查看操作审计

const MATRIX: Record<UserRole, Set<Action>> = {
  PROJECT_OWNER: new Set<Action>([
    'project:view',
    'project:edit',
    'budget:editInitial',
    'budget:editSubjectTree',
    'budget:adjust',
    'budget:changeSubject',
    'record:create',
    'record:edit',
    'record:void',
    'record:import',
    'audit:view',
  ]),
  AUTHORIZED_HANDLER: new Set<Action>([
    'project:view',
    'project:edit',
    'budget:editInitial',
    'budget:editSubjectTree',
    'budget:adjust',
    'budget:changeSubject',
    'record:create',
    'record:edit',
    'record:void',
    'record:import',
    'audit:view',
  ]),
  BUDGET_ADMIN: new Set<Action>([
    'project:view',
    'project:viewAll',
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
  ]),
};

/** 是否有某动作权限(仅按角色,不含项目范围) */
export function can(user: { role: UserRole }, action: Action): boolean {
  return MATRIX[user.role]?.has(action) ?? false;
}

/**
 * 要求用户具备某动作权限;若涉及具体项目,额外校验项目访问范围。
 * 服务端权限再校验(§15.3)。
 */
export async function requirePermission(
  user: { id: string; role: UserRole },
  action: Action,
  projectId?: string,
): Promise<void> {
  if (!can(user, action)) {
    throw new HTTPError(403, `无权限执行操作:${action}`);
  }
  if (projectId && action !== 'project:viewAll') {
    const accessible = await getAccessibleProjectIds(user);
    if (!accessible.includes(projectId)) {
      throw new HTTPError(403, '无权访问该项目');
    }
  }
}
