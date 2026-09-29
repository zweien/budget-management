import { NextRequest, NextResponse } from 'next/server';

import { assertContentLengthBelow, withRoute } from '@/lib/api/withRoute';
import { env } from '@/lib/env';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { parseAndValidate } from '@/server/services/excelImport.service';
import {
  listImportBatches,
  loadWorkbookWithFormatDetection,
  parseSettlement,
} from '@/server/services/settlementImport.service';

/**
 * POST /api/projects/:id/imports — 上传 Excel 文件,解析+校验+疑似重复检测(§10 阶段一)。
 *
 * 接受 multipart/form-data(file 字段为 .xlsx)。
 * 返回 { batchId }(供前端跳转预览页)。
 *
 * exceljs 仅在此 Route Handler(服务端 Node 运行)中解析,不打包进客户端。
 */
export const POST = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;

    // 安全审计 bm1-att-upload-body-buffer-unbounded / bm1-imp:xlsx-decompress-preauthz-parse:
    // 闸门按成本升序——① 声明长度预检(零成本,缓冲前拦明显超限)→ ② formData 缓冲后的
    // 文件形态/大小校验 → ③ 权限校验(触碰 DB)→ ④ 解析(最重,严格置于授权之后)。
    // 最低档凭证不再能借上传通道触发解压解析成本(服务层仍会复核权限)。
    assertContentLengthBelow(req, env.MAX_IMPORT_BYTES);

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少上传文件(file 字段)' }, { status: 400 });
    }
    // 仅接受 .xlsx。
    const name = file.name || 'upload.xlsx';
    if (!/\.xlsx$/i.test(name)) {
      return NextResponse.json({ error: '仅支持 .xlsx 文件' }, { status: 400 });
    }
    // 容量边界:文件大小上限(xlsx 全量进内存解析,须防 OOM/事件循环阻塞)。
    if (file.size > env.MAX_IMPORT_BYTES) {
      throw new HTTPError(
        413,
        `文件 ${name} 超过大小上限 ${Math.round(env.MAX_IMPORT_BYTES / 1024 / 1024)}MB,请拆分后上传`,
      );
    }

    // 权限闸:解析前最后一道(服务层复核;审计要求解析成本只发生在已授权之后)。
    await requirePermission(user, 'record:import', id);

    const arrayBuffer = await file.arrayBuffer();
    // 格式自动识别:命中个人结算单表头(单据编号+单据状态)走结算单解析,否则标准模板。
    // 整个 workbook 只 load 一次,探测与解析复用同一对象(此前标准模板被解析两遍)。
    const { workbook, isSettlement } = await loadWorkbookWithFormatDetection(arrayBuffer);
    const batchId = isSettlement
      ? await parseSettlement(workbook, id, user, name)
      : await parseAndValidate(arrayBuffer, id, user, name, workbook);
    return NextResponse.json({ batchId }, { status: 201 });
  },
);

/**
 * GET /api/projects/:id/imports — 批次列表(最近 20 条)。
 * 供上传页展示「进行中批次」(暂存的结算单导入可从此继续)。
 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const batches = await listImportBatches(id, user);
    return NextResponse.json({ batches });
  },
);
