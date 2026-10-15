import { NextRequest, NextResponse } from 'next/server';

import { assertContentLengthBelow, withRoute } from '@/lib/api/withRoute';
import { env } from '@/lib/env';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { parseSettlementUnified } from '@/server/services/settlementImport.service';

/**
 * POST /api/imports/settlement — 统一导入入口:上传财务结算单(2025 导出,v3)。
 * - 不依赖项目上下文:批次承载项目 = 自动预映射的第一个目标项目;
 *   未命中时带 multipart 字段 hostProjectId(须有 record:import)重传。
 * - 仅接受 v3 版式;系统模板/个人结算单(v1/v2)请在项目内 Excel 导入页上传。
 * - 安全闸(与项目内上传同款,闸门按成本升序):声明长度预检 → selected 范围
 *   凭证拒绝(cross-project 无项目上下文,审计后 403)→ formData 缓冲 → 文件
 *   形态/大小校验 → 解析(最重);解析后映射/确认仍逐目标项目校验权限。
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await requireUser();

  assertContentLengthBelow(req, env.MAX_IMPORT_BYTES);

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: '请求体无效:需要 multipart 表单' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: '缺少上传文件(file)' }, { status: 400 });
  }
  const name = file.name || 'upload.xlsx';
  if (!/\.xlsx$/i.test(name)) {
    return NextResponse.json({ error: '仅支持 .xlsx 文件' }, { status: 400 });
  }
  if (file.size > env.MAX_IMPORT_BYTES) {
    throw new HTTPError(
      413,
      `文件 ${name} 超过大小上限 ${Math.round(env.MAX_IMPORT_BYTES / 1024 / 1024)}MB,请拆分后上传`,
    );
  }
  const hostProjectIdRaw = form.get('hostProjectId');
  const hostProjectId =
    typeof hostProjectIdRaw === 'string' && hostProjectIdRaw.length > 0
      ? hostProjectIdRaw
      : undefined;

  const buffer = await file.arrayBuffer();
  const result = await parseSettlementUnified(
    buffer,
    user,
    file.name || 'upload.xlsx',
    hostProjectId,
  );
  return NextResponse.json(result, { status: 201 });
});
