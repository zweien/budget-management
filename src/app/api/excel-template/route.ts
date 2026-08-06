import { NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { generateTemplateBuffer } from '@/lib/excel/template';

/**
 * GET /api/excel-template — 下载 Excel 导入模板(§10.4)。
 *
 * 返回 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 * 文件流(Content-Disposition: attachment)。
 *
 * exceljs 仅在此服务端 Route Handler 中运行,不打包进客户端。
 * 需登录(模板本身无敏感数据,但不在公网裸奔)。
 */
export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  const buffer = await generateTemplateBuffer();
  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="business-records-template.xlsx"',
      'Cache-Control': 'no-store',
    },
  });
}
