import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { exportLedger } from '@/server/services/export.service';

/**
 * GET /api/projects/:id/export/ledger?year=2026 — 导出预算执行台账 xlsx(§10.5)。
 * year 缺省取当前年份。返回 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet。
 */
export const GET = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
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
  },
);
