import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { listAdminUsers, updateUserAccount } from '@/server/services/adminUser.service';

/**
 * 用户管理服务集成测试(直连真实 PG):
 * 列表(含停用/服务账号标记/成员关系映射)、停用与角色变更审计、
 * 护栏(自伤 422、Bearer 403、非管理员 403、无变化 422、非法值 422)。
 * 注:「最后一个活跃管理员」护栏对本服务不可达(操作者本身即活跃管理员,
 * 自伤由自我护栏拦截),该护栏为纵深防御保留。
 */
describe('adminUser.service (integration, real PG)', () => {
  const createdUserIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdKeyIds: string[] = [];
  let adminId: string;
  let plainId: string;
  let serviceId: string;
  const admin = () => ({ id: adminId, role: UserRole.ADMIN });
  const adminViaKey = () => ({ id: adminId, role: UserRole.ADMIN, viaApiKey: true });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    plainId = uuidv7();
    serviceId = uuidv7();
    createdUserIds.push(adminId, plainId, serviceId);
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'usr-admin', role: UserRole.ADMIN },
        { id: plainId, name: 'usr-plain', role: UserRole.USER },
        { id: serviceId, name: 'usr-service', role: UserRole.USER },
      ],
    });
    // 服务账号标记:serviceId 名下活跃无人值守 Key。
    const plaintext = generateApiKey();
    const keyId = uuidv7();
    createdKeyIds.push(keyId);
    await prisma.apiKey.create({
      data: {
        id: keyId,
        userId: serviceId,
        name: 'unattended',
        keyHash: hashApiKey(plaintext),
        prefix: apiKeyDisplayPrefix(plaintext),
        unattended: true,
        tier: 'full',
        projectScope: 'all',
      },
    });
  });

  afterAll(async () => {
    await prisma.auditLog
      .deleteMany({ where: { operatorId: { in: createdUserIds } } })
      .catch(() => {});
    await prisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } }).catch(() => {});
    await prisma.projectMember
      .deleteMany({ where: { projectId: { in: createdProjectIds } } })
      .catch(() => {});
    for (const id of createdProjectIds.splice(0)) {
      await prisma.project.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('listAdminUsers:含停用用户、服务账号标记、成员关系映射;非管理员/机器凭证 403', async () => {
    const project = await prisma.project.create({
      data: {
        id: uuidv7(),
        code: `UM-${uuidv7().slice(0, 8)}`,
        name: 'usr mgmt',
        ownerId: adminId,
      },
    });
    createdProjectIds.push(project.id);
    await prisma.projectMember.create({
      data: { id: uuidv7(), projectId: project.id, userId: plainId, memberRole: 'HANDLER' },
    });

    const rows = await listAdminUsers(admin());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(adminId)?.role).toBe('ADMIN');
    expect(byId.get(serviceId)?.serviceAccount).toBe(true);
    expect(byId.get(plainId)?.serviceAccount).toBe(false);
    expect(byId.get(plainId)?.memberships).toEqual([
      {
        projectId: project.id,
        projectName: 'usr mgmt',
        projectArchived: false,
        memberRole: 'HANDLER',
      },
    ]);

    // 停用用户仍在列表(管理页需要看见)。
    await prisma.user.update({ where: { id: plainId }, data: { status: 'disabled' } });
    const after = await listAdminUsers(admin());
    expect(after.find((r) => r.id === plainId)?.status).toBe('disabled');
    await prisma.user.update({ where: { id: plainId }, data: { status: 'active' } });

    await expect(listAdminUsers({ id: plainId, role: UserRole.USER })).rejects.toMatchObject({
      status: 403,
    });
    await expect(listAdminUsers(adminViaKey())).rejects.toMatchObject({ status: 403 });
  });

  it('updateUserAccount:提升/降级与停用均写审计(含前后快照)', async () => {
    const promoted = await updateUserAccount(admin(), plainId, { role: 'ADMIN' });
    expect(promoted.role).toBe('ADMIN');
    const roleAudit = await prisma.auditLog.findFirstOrThrow({
      where: { objectType: 'users', objectId: plainId, action: 'user.role_change' },
      orderBy: { operatedAt: 'desc' },
    });
    expect(roleAudit.beforeData).toMatchObject({ role: 'USER' });
    expect(roleAudit.afterData).toMatchObject({ role: 'ADMIN' });
    expect(roleAudit.operatorId).toBe(adminId);

    const disabled = await updateUserAccount(admin(), plainId, { status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    const statusAudit = await prisma.auditLog.findFirstOrThrow({
      where: { objectType: 'users', objectId: plainId, action: 'user.status_change' },
      orderBy: { operatedAt: 'desc' },
    });
    expect(statusAudit.beforeData).toMatchObject({ status: 'active' });
    expect(statusAudit.afterData).toMatchObject({ status: 'disabled' });

    // 还原,避免影响其他用例。
    await updateUserAccount(admin(), plainId, { status: 'active', role: 'USER' });
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'users', objectId: plainId },
    });
    expect(audits.length).toBe(4);
  });

  it('updateUserAccount:护栏——自伤 422、无变化 422、非法值/缺字段 422、目标缺失 404', async () => {
    await expect(updateUserAccount(admin(), adminId, { status: 'disabled' })).rejects.toMatchObject(
      { status: 422, message: expect.stringContaining('自己') },
    );
    await expect(updateUserAccount(admin(), plainId, {})).rejects.toMatchObject({ status: 422 });
    await expect(
      updateUserAccount(admin(), plainId, { status: 'frozen' as never }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('非法状态') });
    await expect(
      updateUserAccount(admin(), plainId, { role: 'OWNER' as never }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('非法角色') });
    await expect(updateUserAccount(admin(), plainId, { role: 'USER' })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('未变化'),
    });
    await expect(
      updateUserAccount(admin(), uuidv7(), { status: 'disabled' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('updateUserAccount:非管理员操作者与 Bearer 凭证一律 403', async () => {
    await expect(
      updateUserAccount({ id: plainId, role: UserRole.USER }, serviceId, { status: 'disabled' }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('仅管理员') });
    await expect(
      updateUserAccount(adminViaKey(), serviceId, { status: 'disabled' }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('机器凭证') });
  });
});
