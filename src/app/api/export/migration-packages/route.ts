/**
 * 批量导出迁移包(ADR 0003):GET /api/export/migration-packages?codes=a,b,c[&includePending=1]
 *
 * 跨项目接口:指定项目范围的 API 凭证直接 403(denyApiKeyCrossProject,与统计/审计
 * 全量同惯例,防范围收窄凭证借跨项目端点绕开行级限制);会话/全范围凭证走
 * project:view 口径。产物为 zip 运输容器,「一包一项目」不变:
 *   - 每项目一个 migration-<编号>.json(与 CLI --all 目录内命名一致)
 *   - manifest.json:exported / skippedPending(含在途单清单) / failed(含原因)
 * PENDING 项目默认跳过进 manifest;includePending=1 等价逐项目 force。
 * 逐项容错(同 CLI --all);全部失败时返回 400 + 原因清单而非空 zip。
 */
import JSZip from 'jszip';
import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { denyApiKeyCrossProject, requirePermission } from '@/lib/auth/permissions';
// Action 是封闭联合类型(无 export 专属动作);跨项目闸门按底层查看动作标注。
import { requireUser } from '@/lib/auth/session';
import { getAppVersion } from '@/lib/build-info';
import { prisma } from '@/lib/prisma';
import {
  contentDispositionAttachment,
  exportProjectPackage,
  migrationPackageArchiveEntryName,
  migrationPackagesArchiveFileName,
  MigrationError,
} from '@/server/services/migrationPackage.service';

const MAX_CODES = 500;

export interface MigrationPackagesManifest {
  kind: 'budget.migration-packages-manifest';
  exportedAt: string;
  appVersion: string;
  includePending: boolean;
  exported: string[];
  skippedPending: { code: string; items: string[] }[];
  failed: { code: string; reason: string }[];
}

export const GET = withRoute(async (req) => {
  const user = await requireUser();
  await denyApiKeyCrossProject(user, 'project:view');

  const sp = req.nextUrl.searchParams;
  const includePending = sp.get('includePending') === '1';
  const codes = (sp.get('codes') ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (codes.length === 0) {
    return NextResponse.json({ error: '缺少 codes 参数(逗号分隔的项目编号)' }, { status: 400 });
  }
  if (codes.length > MAX_CODES) {
    return NextResponse.json({ error: `一次最多导出 ${MAX_CODES} 个项目` }, { status: 400 });
  }
  if (new Set(codes).size !== codes.length) {
    return NextResponse.json({ error: 'codes 存在重复编号' }, { status: 400 });
  }

  // 跨项目端点逐项目校验查看权(归档项目 project:view 亦豁免,与单项目端点同口径)。
  const projects = await prisma.project.findMany({
    where: { code: { in: codes } },
    include: { owner: true },
    orderBy: { code: 'asc' },
  });
  const zip = new JSZip();
  const manifest: MigrationPackagesManifest = {
    kind: 'budget.migration-packages-manifest',
    exportedAt: new Date().toISOString(),
    appVersion: await getAppVersion(),
    includePending,
    exported: [],
    skippedPending: [],
    failed: [],
  };
  const byCode = new Map(projects.map((p) => [p.code, p]));
  for (const code of codes) {
    const project = byCode.get(code);
    if (!project) {
      manifest.failed.push({ code, reason: '项目不存在' });
      continue;
    }
    try {
      await requirePermission(user, 'project:view', project.id);
      const pkg = await exportProjectPackage(project, { force: includePending });
      zip.file(migrationPackageArchiveEntryName(code), `${JSON.stringify(pkg, null, 2)}\n`);
      manifest.exported.push(code);
    } catch (e) {
      if (e instanceof MigrationError && e.message.includes('PENDING')) {
        manifest.skippedPending.push({ code, items: e.details });
      } else {
        manifest.failed.push({ code, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (manifest.exported.length === 0 && manifest.skippedPending.length === 0) {
    return NextResponse.json(
      {
        error: '没有任何项目导出成功',
        details: manifest.failed.map((f) => `${f.code}: ${f.reason}`),
      },
      { status: 400 },
    );
  }

  zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDispositionAttachment(migrationPackagesArchiveFileName()),
      'Cache-Control': 'no-store',
    },
  });
});
