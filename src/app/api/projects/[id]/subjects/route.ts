import { NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/prisma';
import { leafAttachBlockers } from '@/server/services/adjustment.service';

interface SubjectNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  level: number;
  isLeaf: boolean;
  /** 叶科目是否可挂子科目(非叶恒 true);口径与提交校验同源(leafAttachBlockers)。 */
  canAttachChild: boolean;
}

/**
 * GET /api/projects/:id/subjects — 返回项目科目全树(扁平,含非叶节点)。
 * 用于预算调整表单的"新增科目父节点下拉"等场景;canAttachChild 标记叶科目
 * 能否被选为父节点(预算 current 全 0 且无业务记录,与提交校验同一口径)。
 */
export const GET = withRoute(
  async (_: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requirePermission(user, 'project:view', projectId);

    const [subjects, blockers] = await Promise.all([
      prisma.budgetSubject.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: { id: true, code: true, name: true, parentId: true, level: true, isLeaf: true },
      }),
      leafAttachBlockers(prisma, projectId),
    ]);

    const nodes: SubjectNode[] = subjects.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      parentId: s.parentId,
      level: s.level,
      isLeaf: s.isLeaf,
      canAttachChild: !s.isLeaf || (blockers.get(s.id) ?? null) === null,
    }));

    return NextResponse.json({ subjects: nodes });
  },
);
