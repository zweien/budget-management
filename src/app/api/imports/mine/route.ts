import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { listMySettlementBatches } from '@/server/services/settlementImport.service';

/**
 * GET /api/imports/mine — 统一导入入口「进行中批次」列表。
 * 当前用户创建的结算单批次(settlement-1.0/2.0,含已确认),最近 20 条;
 * 附承载项目(行级目标项目映射的容器,行入账按映射走)。
 */
export const GET = withRoute(async () => {
  const user = await requireUser();
  const batches = await listMySettlementBatches(user);
  return NextResponse.json({ batches });
});
