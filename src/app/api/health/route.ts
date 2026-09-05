import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { withRoute } from '@/lib/api/withRoute';

/**
 * GET /api/health — 就绪探针(容器 HEALTHCHECK / 编排器滚动发布用)。
 * 区分「进程活着」与「能服务」:DB 不可达时返回 503,编排器摘除流量。
 */
export const dynamic = 'force-dynamic';

export const GET = withRoute(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok' });
  } catch {
    return NextResponse.json({ status: 'db_unavailable' }, { status: 503 });
  }
});
