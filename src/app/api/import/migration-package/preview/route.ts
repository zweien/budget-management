/**
 * 迁移包导入预检(ADR 0003;仅 ADMIN):POST /api/import/migration-package/preview
 * multipart 上传 .json(单包)或 .zip(批量),逐包完成 校验+只读预检(版本偏差/
 * 同编号冲突/骨架态/包内 PENDING),不写库。确认后由执行端点重传同一文件全量导入。
 */
import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireImportAdmin, readUploadedPackages } from '../_upload';

export const POST = withRoute(async (req) => {
  await requireImportAdmin();
  const parsed = await readUploadedPackages(req);
  return NextResponse.json(
    {
      kind: parsed.kind,
      files: parsed.entries.map((e) => ({
        name: e.name,
        ok: !!e.inspection,
        error: e.error,
        details: e.details,
        inspection: e.inspection,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
