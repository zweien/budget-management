import { User, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { recordAudit } from '@/server/audit/interceptor';

/**
 * 用户管理(集中式,仅管理员交互会话;CONTEXT.md「全局角色/成员角色/停用」)。
 * - 列表含停用账号 + 服务账号标记(名下存在活跃无人值守 Key)+ 全部项目成员关系;
 * - 账户操作仅 停用/启用 与 提升/降级 ADMIN;护栏:不可操作自己、不可动最后一个活跃 ADMIN;
 * - 角色与状态变更随事务写审计(user.role_change / user.status_change,含前后快照)。
 * 红线:一切 Bearer 凭证(含 attended)拒绝——账户管理不低于凭证管理的危险等级。
 */

/** 管理视图用户行(含全部项目成员关系)。 */
export interface AdminUserRow {
  id: string;
  name: string;
  role: UserRole;
  status: string;
  createdAt: Date;
  /** 已绑定 SSO(authSubject 存在,首登可匹配)。 */
  authBound: boolean;
  /** 服务账号:名下存在活跃无人值守 Key。 */
  serviceAccount: boolean;
  memberships: Array<{
    projectId: string;
    projectName: string;
    projectArchived: boolean;
    memberRole: 'OWNER' | 'HANDLER';
  }>;
}

/** 用户管理仅限管理员交互会话(对齐凭证管理红线)。 */
function assertAdminSession(user: Pick<User, 'id' | 'role'> & { viaApiKey?: boolean }): void {
  if (user.viaApiKey) {
    throw new HTTPError(403, '用户管理仅限登录会话使用,机器凭证不得调用');
  }
  if (user.role !== 'ADMIN') {
    throw new HTTPError(403, '仅管理员可管理用户');
  }
}

/** 列出全部用户(含停用;附服务账号标记与项目成员关系)。 */
export async function listAdminUsers(
  operator: Pick<User, 'id' | 'role'> & { viaApiKey?: boolean },
): Promise<AdminUserRow[]> {
  assertAdminSession(operator);
  const [users, unattendedKeys, memberships] = await Promise.all([
    prisma.user.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] }),
    prisma.apiKey.findMany({
      where: {
        unattended: true,
        revokedAt: null,
        // 已过期 Key 不可用(codex P2),不应标记服务账号。
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.projectMember.findMany({
      include: { project: { select: { id: true, name: true, archivedAt: true } } },
    }),
  ]);
  const serviceIds = new Set(unattendedKeys.map((k) => k.userId));
  const membershipsByUser = new Map<string, AdminUserRow['memberships']>();
  for (const m of memberships) {
    const list = membershipsByUser.get(m.userId) ?? [];
    list.push({
      projectId: m.project.id,
      projectName: m.project.name,
      projectArchived: m.project.archivedAt !== null,
      memberRole: m.memberRole,
    });
    membershipsByUser.set(m.userId, list);
  }
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    authBound: u.authSubject !== null,
    serviceAccount: serviceIds.has(u.id),
    memberships: membershipsByUser.get(u.id) ?? [],
  }));
}

export interface UpdateAccountInput {
  status?: 'active' | 'disabled';
  role?: 'ADMIN' | 'USER';
}

export interface UpdateAccountResult {
  id: string;
  name: string;
  role: UserRole;
  status: string;
}

/**
 * 变更账户状态/角色(停用/启用、提升/降级 ADMIN)。
 * 护栏:不可操作自己;不可降级/停用最后一个活跃 ADMIN;无变化 422;变更随事务写审计。
 */
export async function updateUserAccount(
  operator: Pick<User, 'id' | 'role'> & { viaApiKey?: boolean },
  targetUserId: string,
  input: UpdateAccountInput,
): Promise<UpdateAccountResult> {
  assertAdminSession(operator);
  const { status, role } = input;
  if (!status && !role) throw new HTTPError(422, '缺少要变更的字段(status / role)');
  if (status !== undefined && status !== 'active' && status !== 'disabled') {
    throw new HTTPError(422, `非法状态:${status}`);
  }
  if (role !== undefined && role !== 'ADMIN' && role !== 'USER') {
    throw new HTTPError(422, `非法角色:${role}`);
  }
  if (targetUserId === operator.id) {
    throw new HTTPError(422, '不能变更自己的角色或状态');
  }

  return prisma.$transaction(async (tx) => {
    // 最后一个活跃 ADMIN 护栏(原子化,codex P1):先锁全部活跃管理员行再在事务内
    // 重验——并发互降时后提交方会看到前者的结果,不会把最后一名也降掉。
    // ORDER BY 保证加锁顺序确定,避免死锁。
    await tx.$queryRaw`SELECT id FROM users WHERE role = 'ADMIN' AND status = 'active' ORDER BY id FOR UPDATE`;
    const target = await tx.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new HTTPError(404, '用户不存在');

    if (target.role === 'ADMIN' && (role === 'USER' || status === 'disabled')) {
      const otherActiveAdmins = await tx.user.count({
        where: { role: 'ADMIN', status: 'active', id: { not: targetUserId } },
      });
      if (otherActiveAdmins === 0) {
        throw new HTTPError(409, '该账号是最后一个活跃管理员,不可降级或停用');
      }
    }

    const statusChanged = status !== undefined && status !== target.status;
    const roleChanged = role !== undefined && role !== target.role;
    if (!statusChanged && !roleChanged) {
      throw new HTTPError(422, '账号的角色与状态均未变化');
    }

    const data: { status?: string; role?: UserRole } = {};
    if (statusChanged) data.status = status;
    if (roleChanged) data.role = role as UserRole;

    const row = await tx.user.update({ where: { id: targetUserId }, data });
    if (statusChanged) {
      await recordAudit(tx, {
        objectType: 'users',
        objectId: row.id,
        action: 'user.status_change',
        operatorId: operator.id,
        before: { name: target.name, status: target.status },
        after: { name: row.name, status: row.status },
      });
    }
    if (roleChanged) {
      await recordAudit(tx, {
        objectType: 'users',
        objectId: row.id,
        action: 'user.role_change',
        operatorId: operator.id,
        before: { name: target.name, role: target.role },
        after: { name: row.name, role: row.role },
      });
    }
    return { id: row.id, name: row.name, role: row.role, status: row.status };
  });
}
