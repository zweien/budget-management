/**
 * 导出单项目迁移包(ADR 0003)。v0.36.x 起迁移包**导出**开放 UI/API(脱敏产物,
 * 数据面与台账导出同级);快照备份/恢复/导入包仍仅 CLI(红线见 AGENTS.md)。
 *
 * GET /api/projects/:id/export/migration-package[?pendingAcknowledged=1]
 * - 权限: project:view(登录即可,与台账导出同权);不写审计(与既有导出同惯例)。
 * - PENDING 守卫与 CLI 同源:存在待审批单且未带 pendingAcknowledged →
 *   409 { error, details: 在途单清单 }(UI 弹确认后带参重发,agent 吃同一守卫)。
 * - 产物与 CLI 字节同构: migration-<编号>-<日期>.json(JSON.stringify(pkg,null,2)+换行)。
 */
import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requirePermission } from '@/lib/auth/permissions';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import {
  contentDispositionAttachment,
  exportPackageFileName,
  exportProjectPackage,
  MigrationError,
} from '@/server/services/migrationPackage.service';

export const GET = withRoute(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireUser();
  const project = await prisma.project.findUnique({ where: { id }, include: { owner: true } });
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  }
  await requirePermission(user, 'project:view', id);

  const acknowledged = req.nextUrl.searchParams.get('pendingAcknowledged') === '1';
  try {
    const pkg = await exportProjectPackage(project, { force: acknowledged });
    return new NextResponse(`${JSON.stringify(pkg, null, 2)}\n`, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': contentDispositionAttachment(exportPackageFileName(project.code)),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    // MigrationError 不在 withRoute.classify 的映射里(会兜成 500),此处自转 409
    // 并携带在途单清单(错误体扩展 details 字段,前端经 e.body.details 取)。
    if (e instanceof MigrationError) {
      return NextResponse.json({ error: e.message, details: e.details }, { status: 409 });
    }
    throw e;
  }
});
