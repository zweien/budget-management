import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { carryOver } from '@/server/services/yearCarryover.service';

/**
 * POST /api/projects/:id/carryover — 跨年结转(§8.7)。
 * Body: { fromYear: number, toYear: number }。
 * 返回 { carriedCount, warnings: [{originalRecordId, subjectCode, reason}] }。
 *
 * 结转生成可追溯记录(原记录留 carryover_out、新记录留 carryover_in history);
 * PAID 不结转;toYear 可用预算不足 → warnings(不静默丢失,§8.7)。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as { fromYear?: unknown; toYear?: unknown };

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 });
    }
    const { fromYear, toYear } = body;
    if (
      typeof fromYear !== 'number' ||
      !Number.isInteger(fromYear) ||
      typeof toYear !== 'number' ||
      !Number.isInteger(toYear)
    ) {
      return NextResponse.json({ error: 'fromYear/toYear 必须为整数' }, { status: 400 });
    }

    const result = await carryOver(id, fromYear, toYear, user);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
