import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { assertInteractiveSession, revokeApiKey } from '@/server/services/apiKey.service';

/**
 * POST /api/api-keys/:keyId/revoke — 撤销当前用户自己的凭证(幂等)。
 * 仅限登录会话(与 GET/POST /api/api-keys 同一红线)。
 */
export const POST = withRoute(
  async (_req: NextRequest, { params }: { params: Promise<{ keyId: string }> }) => {
    const user = await requireUser();
    assertInteractiveSession(user);
    const { keyId } = await params;
    const key = await revokeApiKey(user.id, keyId);
    return NextResponse.json({ key });
  },
);
