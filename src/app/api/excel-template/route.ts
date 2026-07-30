import { NextResponse } from 'next/server';

import { generateTemplateBuffer } from '@/lib/excel/template';

/**
 * GET /api/excel-template — 下载 Excel 导入模板(§10.4)。
 *
 * 返回 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 * 文件流(Content-Disposition: attachment)。
 *
 * exceljs 仅在此服务端 Route Handler 中运行,不打包进客户端。
 */
export async function GET() {
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
