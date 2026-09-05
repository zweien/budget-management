import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { riskSummary } from '@/server/services/statistics.service';

/**
 * GET /api/statistics/risk-summary — 跨项目风险预警(§12.1):负结余科目,一次取回。
 * Query:year(缺省当前年)。所有登录用户可读;selected-scope 凭证拒绝(服务层强制)。
 * 返回 { rows: [{projectId, projectName, subjectId, subjectCode, subjectName,
 *                budget, occupied, balance, executionRate}] },balance 升序(最负在前)。
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  const yearParam = req.nextUrl.searchParams.get('year');
  let year = new Date().getFullYear();
  if (yearParam !== null) {
    const y = Number.parseInt(yearParam, 10);
    if (!Number.isInteger(y) || y < 1900 || y > 9999) {
      return NextResponse.json({ error: '年度参数无效' }, { status: 400 });
    }
    year = y;
  }
  const result = await riskSummary({ year }, user);
  return NextResponse.json(result);
});
