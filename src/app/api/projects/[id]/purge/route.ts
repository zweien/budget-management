import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { getPurgePreview, purgeArchivedProject } from '@/server/services/project.service';

/** GET /api/projects/:id/purge — 彻底删除预览(数据量/金额;仅管理员登录会话)。 */
export const GET = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const preview = await getPurgePreview(id, user);
    return NextResponse.json(preview);
  },
);

/** POST /api/projects/:id/purge — 执行彻底删除(不可逆;仅管理员登录会话)。 */
export const POST = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const preview = await purgeArchivedProject(id, user);
    return NextResponse.json(preview);
  },
);
