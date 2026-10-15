import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { parseSettlementUnified } from '@/server/services/settlementImport.service';

/**
 * POST /api/imports/settlement — 统一导入入口:上传财务结算单(2025 导出,v3)。
 * - 不依赖项目上下文:批次承载项目 = 自动预映射的第一个目标项目;
 *   未命中时带 multipart 字段 hostProjectId(须有 record:import)重传。
 * - 仅接受 v3 版式;系统模板/个人结算单(v1/v2)请在项目内 Excel 导入页上传。
 * - 解析本身只读(两阶段导入的第一阶段);确认仍逐目标项目校验权限。
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await requireUser();

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: '请求体无效:需要 multipart 表单' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: '缺少上传文件(file)' }, { status: 400 });
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
