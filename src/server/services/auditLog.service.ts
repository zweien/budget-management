import { Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * 操作日志查询服务(§14.1)。
 *
 * 全部 beforeData/afterData 以 Prisma JSON 形式返回(已存为 JSONB),前端展开渲染。
 * 权限:v0.3.0 起普通用户全局只读 → 所有登录用户可见全部审计日志(只读)。
 */

/** §14.1 listAuditLogs 组合筛选条件。 */
export interface AuditLogFilters {
  projectId?: string;
  objectType?: string;
  objectId?: string;
  action?: string;
  operatorId?: string;
  /** ISO yyyy-mm-dd(含)。 */
  dateFrom?: string;
  /** ISO yyyy-mm-dd(含)。 */
  dateTo?: string;
}

/** 分页参数(均为可选)。 */
export interface AuditLogPagination {
  limit?: number;
  offset?: number;
}

/** 单条审计日志(含操作人姓名)。 */
export type AuditLogRow = Prisma.AuditLogGetPayload<{
  include: { operator: { select: { id: true; name: true } } };
}>;

export interface ListAuditLogsResult {
  logs: AuditLogRow[];
  /** 当前筛选条件下的总条数(便于前端分页)。 */
  total: number;
}

/** 校验 ISO yyyy-mm-dd,返回 UTC 0 点 Date(避免时区漂移);无效抛 TypeError。 */
function parseDateBound(s: string, label: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    throw new TypeError(`${label} 日期格式无效(应为 yyyy-mm-dd):${s}`);
  }
  const dt = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) {
    throw new TypeError(`${label} 日期无效:${s}`);
  }
  return dt;
}

/**
 * 列出审计日志(§14.1)。
 *
 * 权限:
 * - v0.3.0 起普通用户全局只读 → 所有登录用户可见全部审计日志(只读,无编辑面)。
 *   若显式传入 projectId,按传入值过滤即可(不存在"不可见项目"的概念)。
 *
 * 筛选:projectId/objectType/objectId/action/operatorId/dateFrom/dateTo(全部可选,AND 组合)。
 *
 * 返回 { logs, total }:logs 按 operatedAt desc 排序;total 为当前 where 的全量计数。
 */
export async function listAuditLogs(
  filters: AuditLogFilters,
  user: Pick<User, 'id' | 'role'>,
  pagination: AuditLogPagination = {},
): Promise<ListAuditLogsResult> {
  // 1) 项目范围:全局只读 → 不再按可访问项目裁剪。
  void user;

  // 2) 构建 where。
  const where: Prisma.AuditLogWhereInput = {};

  if (filters.projectId) {
    where.projectId = filters.projectId;
  }
  if (filters.objectType) where.objectType = filters.objectType;
  if (filters.objectId) where.objectId = filters.objectId;
  if (filters.action) where.action = filters.action;
  if (filters.operatorId) where.operatorId = filters.operatorId;
  if (filters.dateFrom || filters.dateTo) {
    where.operatedAt = {};
    if (filters.dateFrom) {
      where.operatedAt.gte = parseDateBound(filters.dateFrom, 'dateFrom');
    }
    if (filters.dateTo) {
      // dateTo 含当日:取次日 0 点 UTC 作为上界(排除法),等价于 [dateTo, dateTo+1)。
      const upper = parseDateBound(filters.dateTo, 'dateTo');
      where.operatedAt.lt = new Date(upper.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // 3) 分页参数(防御性夹取)。
  const limit =
    pagination.limit !== undefined && Number.isFinite(pagination.limit)
      ? Math.max(1, Math.min(500, Math.floor(pagination.limit)))
      : 100;
  const offset =
    pagination.offset !== undefined && Number.isFinite(pagination.offset)
      ? Math.max(0, Math.floor(pagination.offset))
      : 0;

  // 4) 并行查列表 + 计数。
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { operatedAt: 'desc' },
      take: limit,
      skip: offset,
      include: { operator: { select: { id: true, name: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
}
