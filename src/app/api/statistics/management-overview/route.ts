import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { managementOverview } from '@/server/services/statistics.service';

/**
 * GET /api/statistics/management-overview — 管理决策总览(工作台一次取回)。
 * 所有登录用户可用(全局只读);selected-scope 凭证拒绝(跨项目接口)。
 * 返回 { year, monthlyTrend, dueForCompletion, executionLagging, overspend }:
 * - monthlyTrend: 近 12 个月跨项目月度执行;
 * - dueForCompletion: 应结题(结束日期 ≤ 本年度年末,未归档),结束日期升序;
 * - executionLagging: 执行率不足(执行率 < 时间进度),差距降序;
 * - overspend: 超支项目(总结余 < 0),结余升序。
 */
export const GET = withRoute(async () => {
  const user = await requireUser();
  const result = await managementOverview(user);
  return NextResponse.json(result);
});
