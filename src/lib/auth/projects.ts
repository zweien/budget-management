import { UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * 返回用户可访问(查看)的项目 ID 列表。
 * v0.3.0 起普通用户全局只读 → 所有登录用户可查看全部项目;
 * 编辑权另由 canEditProject / getEditableProjectIds 判定。
 * (参数保留仅为兼容既有调用点,结果与调用者无关。)
 */
export async function getAccessibleProjectIds(_user: {
  id: string;
  role: UserRole;
}): Promise<string[]> {
  void _user; // 参数仅为兼容既有调用点;查看范围与调用者无关。
  const all = await prisma.project.findMany({ select: { id: true } });
  return all.map((p) => p.id);
}

/**
 * 返回用户可编辑的项目 ID 列表:管理员=全部;普通用户=其为 OWNER 成员的项目。
 * 供列表页 UI 门控与服务端批量校验使用;单项目判定用 canEditProject(permissions.ts)。
 */
export async function getEditableProjectIds(user: {
  id: string;
  role: UserRole;
}): Promise<string[]> {
  if (user.role === 'ADMIN') {
    return getAccessibleProjectIds(user);
  }
  const owned = await prisma.projectMember.findMany({
    where: { userId: user.id, memberRole: 'OWNER' },
    select: { projectId: true },
  });
  return owned.map((m) => m.projectId);
}
