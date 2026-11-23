import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { getProjectLedger, resolveLedgerDefaultYear } from '@/server/services/ledger.service';

/**
 * GET /api/projects/:id/ledger?year=2026 — 预算执行台账(树形科目 + 实时占用,§11.1/11.2)。
 * 返回扁平 nodes 数组(含 parentId),前端按 parentId 组装树。
 * year 缺省:按系统设置的「台账默认年度」裁决(当前年度 / 该项目最近有预算的年度),
 * 并在响应里附 years(年度下拉候选);显式传 year 时不附,前端沿用固定窗口。
 */
export const GET = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const yearParam = req.nextUrl.searchParams.get('year');
    let year: number;
    let years: number[] = [];
    if (yearParam) {
      year = Number.parseInt(yearParam, 10);
      if (!Number.isInteger(year) || year < 1900 || year > 9999) {
        return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
      }
    } else {
      ({ year, years } = await resolveLedgerDefaultYear(id));
    }
    const ledger = await getProjectLedger(id, year, user);
    return NextResponse.json(years.length > 0 ? { ...ledger, years } : ledger);
  },
);
