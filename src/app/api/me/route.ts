import { NextResponse } from 'next/server';

import { requireUser, HTTPError } from '@/lib/auth/session';

/** GET /api/me — 返回当前 mock 登录用户(供前端展示身份)。 */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ id: user.id, name: user.name, role: user.role });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
