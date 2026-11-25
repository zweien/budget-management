import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemberRole, UserRole } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

import { prisma } from '@/lib/prisma';
import { createProject } from '@/server/services/project.service';
import {
  addMember,
  listMembers,
  removeMember,
  reorderMembers,
  updateMemberRole,
} from '@/server/services/member.service';
import { canEditProject } from '@/lib/auth/permissions';

describe('member.service(集成,真实 PG)', () => {
  let adminId: string;
  let userA: string;
  let userB: string;
  const projectIds: string[] = [];

  const admin = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    userA = uuidv7();
    userB = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'member-admin', role: UserRole.ADMIN },
        { id: userA, name: 'member-a', role: UserRole.USER },
        { id: userB, name: 'member-b', role: UserRole.USER },
      ],
    });
  });

  afterAll(async () => {
    for (const id of projectIds.splice(0)) {
      await prisma.auditLog.deleteMany({ where: { projectId: id } }).catch(() => {});
      await prisma.projectMember.deleteMany({ where: { projectId: id } }).catch(() => {});
      await prisma.projectBudget.deleteMany({ where: { projectId: id } }).catch(() => {});
      await prisma.project.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user
      .deleteMany({ where: { id: { in: [adminId, userA, userB] } } })
      .catch(() => {});
    await prisma.$disconnect();
  });

  async function seedProject(suffix: string) {
    const project = await createProject(
      { code: `MB-${suffix}-${uuidv7().slice(0, 8)}`, name: `member ${suffix}` },
      admin(),
    );
    projectIds.push(project.id);
    return project;
  }

  it('addMember:ADMIN 添加 OWNER 成员后,该用户获得项目编辑权', async () => {
    const project = await seedProject('ADD');
    // 初始:只有创建者(admin)是 OWNER。
    const initial = await listMembers(project.id, admin());
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ userId: adminId, memberRole: MemberRole.OWNER });

    await addMember(project.id, { userId: userA, memberRole: MemberRole.OWNER }, admin());
    await expect(canEditProject({ id: userA, role: UserRole.USER }, project.id)).resolves.toBe(
      true,
    );

    const members = await listMembers(project.id, admin());
    expect(members.map((m) => m.userId).sort()).toEqual([adminId, userA].sort());
  });

  it('addMember:重复添加 409;非 ADMIN 403', async () => {
    const project = await seedProject('DUP');
    await addMember(project.id, { userId: userA, memberRole: MemberRole.HANDLER }, admin());
    await expect(
      addMember(project.id, { userId: userA, memberRole: MemberRole.OWNER }, admin()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      addMember(
        project.id,
        { userId: userB, memberRole: MemberRole.OWNER },
        { id: userA, role: UserRole.USER },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('updateMemberRole:HANDLER(只读)→ OWNER 后获得编辑权;审计留痕', async () => {
    const project = await seedProject('UPD');
    await addMember(project.id, { userId: userA, memberRole: MemberRole.HANDLER }, admin());
    await expect(canEditProject({ id: userA, role: UserRole.USER }, project.id)).resolves.toBe(
      false,
    );

    await updateMemberRole(project.id, userA, MemberRole.OWNER, admin());
    await expect(canEditProject({ id: userA, role: UserRole.USER }, project.id)).resolves.toBe(
      true,
    );

    const audit = await prisma.auditLog.findFirst({
      where: { projectId: project.id, objectType: 'project_members', action: 'update' },
    });
    expect(audit).not.toBeNull();
  });

  it('updateMemberRole:角色变更刷新授权时间(同角色重复更新不动)', async () => {
    const project = await seedProject('TS');
    await addMember(project.id, { userId: userA, memberRole: MemberRole.HANDLER }, admin());
    const before = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: userA } },
    });

    // 同角色更新:授权时间不变。
    await updateMemberRole(project.id, userA, MemberRole.HANDLER, admin());
    const same = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: userA } },
    });
    expect(same.authorizedAt.getTime()).toBe(before.authorizedAt.getTime());

    // 晋升 OWNER:授权时间刷新为最近一次授权(重新授权的记录语义;
    // 成员排序已由 sortOrder 驱动,授权时间不再影响第一负责人的取值)。
    await new Promise((r) => setTimeout(r, 5));
    await updateMemberRole(project.id, userA, MemberRole.OWNER, admin());
    const after = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: userA } },
    });
    expect(after.authorizedAt.getTime()).toBeGreaterThan(before.authorizedAt.getTime());
  });

  it('removeMember:移除后编辑权消失;移除不存在成员 404', async () => {
    const project = await seedProject('DEL');
    await addMember(project.id, { userId: userA, memberRole: MemberRole.OWNER }, admin());
    await removeMember(project.id, userA, admin());
    await expect(canEditProject({ id: userA, role: UserRole.USER }, project.id)).resolves.toBe(
      false,
    );
    await expect(removeMember(project.id, userA, admin())).rejects.toMatchObject({ status: 404 });
  });

  it('addMember:新成员追加到顺序末尾', async () => {
    const project = await seedProject('ORDER-ADD');
    await addMember(project.id, { userId: userA, memberRole: MemberRole.OWNER }, admin());
    await addMember(project.id, { userId: userB, memberRole: MemberRole.HANDLER }, admin());
    const members = await listMembers(project.id, admin());
    expect(members.map((m) => m.userId)).toEqual([adminId, userA, userB]);
  });

  it('reorderMembers:顺序持久,listMembers 跟随;审计留痕', async () => {
    const project = await seedProject('REORDER');
    await addMember(project.id, { userId: userA, memberRole: MemberRole.OWNER }, admin());
    await addMember(project.id, { userId: userB, memberRole: MemberRole.HANDLER }, admin());

    // 打乱为 userB / admin / userA:第一负责人变为 userB。
    const members = await reorderMembers(project.id, [userB, adminId, userA], admin());
    expect(members.map((m) => m.userId)).toEqual([userB, adminId, userA]);
    await expect(listMembers(project.id, admin())).resolves.toEqual(members);

    const first = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: userB } },
    });
    const last = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: userA } },
    });
    expect(first.sortOrder).toBe(1);
    expect(last.sortOrder).toBe(3);

    const audit = await prisma.auditLog.findFirst({
      where: { projectId: project.id, objectType: 'project_members', action: 'reorder' },
    });
    expect(audit).not.toBeNull();
  });

  it('reorderMembers:order 不重不漏校验(缺/多/重复 422);非 ADMIN 403', async () => {
    const project = await seedProject('REORDER-V');
    await addMember(project.id, { userId: userA, memberRole: MemberRole.HANDLER }, admin());

    await expect(reorderMembers(project.id, [adminId], admin())).rejects.toMatchObject({
      status: 422,
    }); // 缺 userA
    await expect(
      reorderMembers(project.id, [adminId, userA, userB], admin()),
    ).rejects.toMatchObject({ status: 422 }); // 多 userB(非成员)
    await expect(reorderMembers(project.id, [adminId, adminId], admin())).rejects.toMatchObject({
      status: 422,
    }); // 重复
    await expect(
      reorderMembers(project.id, [userA, adminId], { id: userA, role: UserRole.USER }),
    ).rejects.toMatchObject({ status: 403 }); // 非 ADMIN
  });
});
