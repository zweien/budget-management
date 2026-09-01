import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { getSubjectMappings } from '@/server/services/subjectMapping.service';

/**
 * GET /api/projects/:id/subject-mappings?q=&limit= — 科目映射记忆(供 agent 导入自动指派)。
 * q:摘要包含匹配(不区分大小写);limit:条数上限(默认 200,最大 500)。
 * 返回 { mappings: [{ summary, subjectId, subjectCode, subjectName, useCount, lastUsedAt }] }。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    await requirePermission(user, 'project:view', id);

    const sp = req.nextUrl.searchParams;
    const q = sp.get('q') ?? undefined;
    let limit: number | undefined;
    const limitParam = sp.get('limit');
    if (limitParam !== null) {
      const n = Number.parseInt(limitParam, 10);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: 'limit 参数无效' }, { status: 400 });
      }
      limit = n;
    }

    const mappings = await getSubjectMappings(id, { q, limit });
    return NextResponse.json({ mappings });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
