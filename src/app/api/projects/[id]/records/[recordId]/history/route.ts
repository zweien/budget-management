import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/projects/:id/records/:recordId/history — 某条业务记录的变更历史(§17.7)。
 *
 * 返回 business_record_history 行(按 operatedAt 升序,展示变更链):
 *   [{ id, action, beforeData, afterData, operatorId, operatedAt, reason }]
 *
 * 权限:project:view + 项目范围(查看记录历史归入"查看获授权项目")。
 * 额外校验:该 recordId 必须属于路径中的项目 id(避免越权读他项目记录历史)。
 */
export const GET = withRoute(
  async (_req: Request, { params }: { params: Promise<{ id: string; recordId: string }> }) => {
    const user = await requireUser();
    const { id: projectId, recordId } = await params;

    await requirePermission(user, 'project:view', projectId);

    // 校验记录属于该项目(不存在或归属他项目 → 404,避免泄漏存在性)。
    const record = await prisma.businessRecord.findUnique({
      where: { id: recordId },
      select: { projectId: true },
    });
    if (!record || record.projectId !== projectId) {
      throw new HTTPError(404, '业务记录不存在');
    }

    const rows = await prisma.businessRecordHistory.findMany({
      where: { businessRecordId: recordId },
      orderBy: { operatedAt: 'asc' },
    });

    return NextResponse.json({ history: rows });
  },
);
