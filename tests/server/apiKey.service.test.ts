import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { HTTPError } from '@/lib/auth/session';
import { verifyApiKey } from '@/lib/auth/api-key';
import {
  assertInteractiveSession,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
} from '@/server/services/apiKey.service';

/**
 * API 凭证管理服务集成测试(直连真实 PG):签发校验(档位/项目范围/有效期)、
 * 明文一次性往返、交互会话红线(拒绝机器凭证)、撤销与归属。
 */
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('apiKey.service (integration, real PG)', () => {
  const createdUserIds: string[] = [];
  const createdProjectIds: string[] = [];
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    await prisma.$connect();
    userId = uuidv7();
    await prisma.user.create({
      data: { id: userId, name: 'key-owner-test', role: UserRole.USER },
    });
    createdUserIds.push(userId);
    projectId = uuidv7();
    await prisma.project.create({
      data: {
        id: projectId,
        code: `KEY-${uuidv7().slice(-12)}`,
        name: 'key scope project',
        ownerId: userId,
      },
    });
    createdProjectIds.push(projectId);
  });

  afterAll(async () => {
    await prisma.auditLog
      .deleteMany({ where: { operatorId: { in: createdUserIds } } })
      .catch(() => {});
    await prisma.apiKey.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.projectMember
      .deleteMany({ where: { userId: { in: createdUserIds } } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('assertInteractiveSession:Bearer 凭证一律 403(防自我签发)', () => {
    expect(() => assertInteractiveSession({ viaApiKey: true })).toThrow(HTTPError);
    expect(() => assertInteractiveSession({ viaApiKey: true })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => assertInteractiveSession({ viaApiKey: false })).not.toThrow();
  });

  it('issueApiKey:非法档位/项目/有效期 → 422', async () => {
    const base = { userId, name: 'x', unattended: true, projectScope: 'all' as const };
    await expect(issueApiKey({ ...base, tier: 'admin' as never })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      issueApiKey({ ...base, tier: 'read', projectScope: 'selected', projectIds: [] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      issueApiKey({ ...base, tier: 'read', projectScope: 'selected', projectIds: [uuidv7()] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(issueApiKey({ ...base, tier: 'read', expiresInDays: 0 })).rejects.toMatchObject({
      status: 422,
    });
    await expect(issueApiKey({ ...base, tier: 'read', expiresInDays: 4000 })).rejects.toMatchObject(
      { status: 422 },
    );
    // 未知 projectScope 必须拒绝,否则权限层按 'all' 处理、范围比请求的更宽(codex P1)
    await expect(
      issueApiKey({ ...base, tier: 'read', projectScope: 'selected ' as never }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('项目范围无效') });
  });

  it('issueApiKey:签发 → 明文可认证 → 列表可见 → 撤销后 401', async () => {
    const { record, plaintext } = await issueApiKey({
      userId,
      name: ' e2e key ',
      unattended: true,
      tier: 'write',
      projectScope: 'selected',
      projectIds: [projectId, projectId], // 重复 id 应去重
      expiresInDays: 90,
    });
    expect(record.name).toBe('e2e key');
    expect(record.tier).toBe('write');
    expect(record.projectScope).toBe('selected');
    expect(Array.isArray(record.projectIds) && record.projectIds).toEqual([projectId]);
    expect(record.expiresAt).not.toBeNull();

    const authed = await verifyApiKey(plaintext);
    expect(authed?.id).toBe(userId);
    expect(authed?.keyTier).toBe('write');
    expect(authed?.keyProjectIds).toEqual([projectId]);

    const keys = await listApiKeys(userId);
    expect(keys.some((k) => k.id === record.id)).toBe(true);

    await revokeApiKey(userId, record.id);
    await expect(verifyApiKey(plaintext)).resolves.toBeNull();
    // 幂等:重复撤销不再报错(不重复写审计)
    await expect(revokeApiKey(userId, record.id)).resolves.toMatchObject({ id: record.id });

    // 生命周期入审计链:签发/撤销各一条,afterData 只含公开字段(无哈希/明文)
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'api_keys', objectId: record.id },
      orderBy: { operatedAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['apikey.issue', 'apikey.revoke']);
    expect(audits.every((a) => a.operatorId === userId)).toBe(true);
    const issuedAfter = audits[0].afterData as Record<string, unknown> | null;
    expect(issuedAfter?.prefix).toBe(record.prefix);
    expect(JSON.stringify(audits)).not.toContain('keyHash');
    expect(JSON.stringify(audits)).not.toContain(plaintext);
    const revokeBefore = audits[1].beforeData as Record<string, unknown> | null;
    expect(revokeBefore?.revokedAt).toBeNull();
  });

  it('revokeApiKey:非本人凭证 → 404', async () => {
    const otherId = uuidv7();
    await prisma.user.create({
      data: { id: otherId, name: 'key-other-test', role: UserRole.USER },
    });
    createdUserIds.push(otherId);
    const { record } = await issueApiKey({
      userId: otherId,
      name: 'others',
      unattended: true,
      tier: 'read',
      projectScope: 'all',
    });
    await expect(revokeApiKey(userId, record.id)).rejects.toMatchObject({ status: 404 });
  });
});
