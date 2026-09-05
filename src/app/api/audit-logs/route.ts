import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { requirePermission, denyApiKeyCrossProject } from '@/lib/auth/permissions';
import { listAuditLogs, type AuditLogFilters } from '@/server/services/auditLog.service';

/**
 * GET /api/audit-logs — 操作日志查询(§14.1)。
 * Query 参数(全部可选):
 *   projectId, objectType, objectId, action, operatorId,
 *   dateFrom, dateTo (yyyy-mm-dd, 含),
 *   limit, offset (分页)。
 * 权限:admin 见全部;非 admin 限本项目(由服务层强制)。
 * 返回 { logs: [...], total }。
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;

  const filters: AuditLogFilters = {};
  const projectId = sp.get('projectId');
  if (projectId) filters.projectId = projectId;
  const objectType = sp.get('objectType');
  if (objectType) filters.objectType = objectType;
  const objectId = sp.get('objectId');
  if (objectId) filters.objectId = objectId;
  const action = sp.get('action');
  if (action) filters.action = action;
  const operatorId = sp.get('operatorId');
  if (operatorId) filters.operatorId = operatorId;
  const dateFrom = sp.get('dateFrom');
  if (dateFrom) filters.dateFrom = dateFrom;
  const dateTo = sp.get('dateTo');
  if (dateTo) filters.dateTo = dateTo;

  const limitParam = sp.get('limit');
  const offsetParam = sp.get('offset');
  const pagination: { limit?: number; offset?: number } = {};
  if (limitParam !== null) {
    const n = Number.parseInt(limitParam, 10);
    if (!Number.isInteger(n)) {
      return NextResponse.json({ error: 'limit 参数无效' }, { status: 400 });
    }
    pagination.limit = n;
  }
  if (offsetParam !== null) {
    const n = Number.parseInt(offsetParam, 10);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: 'offset 参数无效' }, { status: 400 });
    }
    pagination.offset = n;
  }

  // 项目范围收窄(codex P1):带 projectId 时校验该projectId 在 allowlist;
  // 无 projectId 的全量审计为跨项目接口,selected-scope 凭证拒绝。
  if (filters.projectId) {
    await requirePermission(user, 'project:view', filters.projectId);
  } else {
    await denyApiKeyCrossProject(user, 'project:view');
  }

  const result = await listAuditLogs(filters, user, pagination);
  return NextResponse.json(result);
});
