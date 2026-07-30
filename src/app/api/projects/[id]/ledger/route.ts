import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { getProjectLedger } from '@/server/services/ledger.service';

/**
 * GET /api/projects/:id/ledger?year=2026 — 预算执行台账(树形科目 + 实时占用,§11.1/11.2)。
 * year 缺省取当前年份。返回扁平 nodes 数组(含 parentId),前端按 parentId 组装树。
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
    const ledger = await getProjectLedger(id, year, user);
    return NextResponse.json(ledger);
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
