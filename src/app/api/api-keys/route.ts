import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import {
  assertInteractiveSession,
  CreateApiKeyInput,
  issueApiKey,
  listApiKeys,
  toPublicApiKey,
} from '@/server/services/apiKey.service';

/**
 * GET /api/api-keys — 当前用户的凭证列表(不含任何明文/哈希)。
 * POST /api/api-keys — 创建个人凭证,明文仅在本次响应返回一次。
 *
 * 红线(ADR 0001):凭证管理仅限登录会话;Bearer 机器凭证一律 403
 * (含 attended 凭证——防 agent 自我签发凭证)。
 */
export const GET = withRoute(async () => {
  const user = await requireUser();
  assertInteractiveSession(user);
  const keys = await listApiKeys(user.id);
  return NextResponse.json({ keys });
});

export const POST = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  assertInteractiveSession(user);
  const body = (await req.json().catch(() => null)) as Partial<CreateApiKeyInput> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  }
  const { record, plaintext } = await issueApiKey({
    userId: user.id,
    name: String(body.name ?? ''),
    unattended: body.unattended !== false,
    tier: (body.tier ?? 'full') as CreateApiKeyInput['tier'],
    projectScope: (body.projectScope ?? 'all') as CreateApiKeyInput['projectScope'],
    projectIds: Array.isArray(body.projectIds) ? (body.projectIds as string[]) : undefined,
    expiresInDays: body.expiresInDays ?? null,
  });
  return NextResponse.json({ key: toPublicApiKey(record), plaintext }, { status: 201 });
});
