import { NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/prisma';

interface SubjectNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  level: number;
  isLeaf: boolean;
}

/**
 * GET /api/projects/:id/subjects — 返回项目科目全树(扁平,含非叶节点)。
 * 用于预算调整表单的"新增科目父节点下拉"等场景。
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requirePermission(user, 'project:view', projectId);

    const subjects = await prisma.budgetSubject.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, parentId: true, level: true, isLeaf: true },
    });

    const nodes: SubjectNode[] = subjects.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      parentId: s.parentId,
      level: s.level,
      isLeaf: s.isLeaf,
    }));

    return NextResponse.json({ subjects: nodes });
  } catch (e) {
    if (e instanceof HTTPError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
