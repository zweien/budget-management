import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { parseAndValidate } from '@/server/services/excelImport.service';

/**
 * POST /api/projects/:id/imports — 上传 Excel 文件,解析+校验+疑似重复检测(§10 阶段一)。
 *
 * 接受 multipart/form-data(file 字段为 .xlsx)。
 * 返回 { batchId }(供前端跳转预览页)。
 *
 * exceljs 仅在此 Route Handler(服务端 Node 运行)中解析,不打包进客户端。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;

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

    const arrayBuffer = await file.arrayBuffer();
    const batchId = await parseAndValidate(arrayBuffer, id, user, name);
    return NextResponse.json({ batchId }, { status: 201 });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
