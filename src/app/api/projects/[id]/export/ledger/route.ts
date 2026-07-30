import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { exportLedger } from '@/server/services/export.service';

/**
 * GET /api/projects/:id/export/ledger?year=2026 — 导出预算执行台账 xlsx(§10.5)。
 * year 缺省取当前年份。返回 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const yearParam = req.nextUrl.searchParams.get('year');
    const year = yearParam ? Number.parseInt(yearParam, 10) : new Date().getFullYear();
    if (!Number.isInteger(year) || year < 1900 || year > 9999) {
      return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
    }

    const buffer = await exportLedger(id, year, user);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="ledger-${year}.xlsx"`,
      },
    });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
