/**
 * 迁移包导入执行(ADR 0003;仅 ADMIN):POST /api/import/migration-package
 * multipart 重传 preview 的同一文件 + 表单字段 ownerUserId / overwrite=1 / allowSkew=1。
 * 逐包独立事务(一包失败不牵连其余);执行端不信任前端——importPackage 内全量重跑
 * 全部守卫。UI/API 路径写审计(action=import,与业务同事务);CLI 不经此端点。
 * 响应 { results:[...] },全部失败 → 400。
 */
import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import {
  importPackage,
  MigrationError,
  type ImportReport,
} from '@/server/services/migrationPackage.service';
import { requireImportAdmin, readUploadedPackages } from './_upload';

export interface ImportResultEntry {
  code: string | null;
  name: string | null;
  status: 'imported' | 'failed';
  reason?: string;
  details?: string[];
  report?: ImportReport;
}

export const POST = withRoute(async (req) => {
  const user = await requireImportAdmin();
  const { entries, form } = await readUploadedPackages(req);

  const ownerUserId = (form.get('ownerUserId') as string | null)?.trim() || undefined;
  const overwrite = form.get('overwrite') === '1';
  const allowSkew = form.get('allowSkew') === '1';

  const results: ImportResultEntry[] = [];
  for (const entry of entries) {
    if (!entry.pkg) {
      results.push({
        code: null,
        name: null,
        status: 'failed',
        reason: entry.error,
        details: entry.details,
      });
      continue;
    }
    try {
      const report = await importPackage(entry.pkg, {
        ownerUserId,
        overwrite,
        allowSkew,
        actor: { id: user.id },
      });
      results.push({
        code: report.projectCode,
        name: report.projectName,
        status: 'imported',
        report,
      });
    } catch (e) {
      if (e instanceof MigrationError) {
        results.push({
          code: entry.pkg.project.code,
          name: entry.pkg.project.name,
          status: 'failed',
          reason: e.message,
          details: e.details,
        });
      } else {
        throw e;
      }
    }
  }

  const imported = results.filter((r) => r.status === 'imported').length;
  // 全部失败:400 + 逐项原因(zip 混合结果仍 200,前端按清单展示)。
  if (imported === 0) {
    return NextResponse.json(
      {
        error: '没有任何项目导入成功',
        results,
      },
      { status: 400 },
    );
  }
  return NextResponse.json({ imported, results }, { headers: { 'Cache-Control': 'no-store' } });
});
