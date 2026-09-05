import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { env } from '@/lib/env';

/**
 * GET /api/me — 当前登录用户。
 * authMode 告知前端顶栏渲染哪种身份控件:
 * mock=开发用模拟用户选择器;sso=真实用户菜单(含退出登录)。
 */
export const GET = withRoute(async () => {
  const user = await requireUser();
  return NextResponse.json({
    id: user.id,
    name: user.name,
    role: user.role,
    authMode: env.MOCK_AUTH ? 'mock' : 'sso',
  });
});
