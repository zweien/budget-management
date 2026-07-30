import { UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * 返回用户可访问的项目 ID 列表。
 * 预算管理员返回全部项目;否则返回其作为 owner 或成员(经办人)的项目。
 */
export async function getAccessibleProjectIds(user: {
  id: string;
  role: UserRole;
}): Promise<string[]> {
  if (user.role === 'BUDGET_ADMIN') {
    const all = await prisma.project.findMany({ select: { id: true } });
    return all.map((p) => p.id);
  }
  const owned = await prisma.project.findMany({
    where: { ownerId: user.id },
    select: { id: true },
  });
  const member = await prisma.projectMember.findMany({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const set = new Set<string>([...owned.map((p) => p.id), ...member.map((m) => m.projectId)]);
  return Array.from(set);
}
