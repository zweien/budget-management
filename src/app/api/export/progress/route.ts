import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { getExportProgress } from '@/server/exports/progress';

/**
 * GET /api/export/progress?id=<随机id> — 查询导出进度(阶段/百分比/状态)。
 * 与导出端点(如 /api/projects/:id/export/funding-report?progress=<id>)配套:
 * 值只有阶段文案与数字、不含任何业务数据;需登录(与导出同权口径)。
 * 过期或未知 id 返回 404,前端按「无进度」降级为纯转圈。
 */
export const GET = withRoute(async (req: NextRequest) => {
  await requireUser();
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    return NextResponse.json({ error: '进度 id 无效' }, { status: 400 });
  }
  const progress = getExportProgress(id);
  if (!progress) {
    return NextResponse.json({ error: '进度不存在或已过期' }, { status: 404 });
  }
  return NextResponse.json({ progress }, { headers: { 'Cache-Control': 'no-store' } });
});
