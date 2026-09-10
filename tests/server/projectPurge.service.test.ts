import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { BusinessStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  archiveProject,
  createProject,
  getPurgePreview,
  purgeArchivedProject,
} from '@/server/services/project.service';
import { customStatistics } from '@/server/services/statistics.service';

/** purge 用例的清理(失败残留兜底;成功路径数据已被 purge 自身删除)。 */
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecordHistory
    .deleteMany({ where: { businessRecord: { projectId } } })
    .catch(() => {});
  await prisma.recordAttachment.deleteMany({ where: { record: { projectId } } }).catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('project purge (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  let outsiderId: string; // 非管理员

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.create({ data: { id: adminId, name: 'purge-admin', role: UserRole.ADMIN } });
    await prisma.user.create({
      data: { id: outsiderId, name: 'purge-outsider', role: UserRole.USER },
    });
  });

  afterEach(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
  });

  afterAll(async () => {
    // purge 审计行按裁决保留(不随项目删除);测试收尾先清本组审计再删用户(operatorId FK)。
    await prisma.auditLog.deleteMany({ where: { operatorId: { in: [adminId, outsiderId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, outsiderId] } } });
    await prisma.$disconnect();
  });

  /** 建项目 + 叶科目 + 一条已支出记录,返回 { project, subject, record }。 */
  async function seedProjectWithRecord() {
    const code = `PURGE-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: '彻底删除测试项目' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    const subject = await prisma.budgetSubject.create({
      data: {
        id: uuidv7(),
        projectId: project.id,
        code: 'S1',
        name: '测试科目',
        level: 1,
        isLeaf: true,
      },
    });
    const record = await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId: project.id,
        budgetYear: 2026,
        subjectId: subject.id,
        amount: 500,
        businessDate: new Date('2026-06-20'),
        handler: '经办人',
        summary: 'purge-rec',
        status: BusinessStatus.PAID,
        createdById: adminId,
      },
    });
    return { project, subject, record, code };
  }

  it('purge: 未归档 409;机器凭证 403(含 attended,无人值守落被拒审计);非管理员 403;编号不符 422', async () => {
    const { project, code } = await seedProjectWithRecord();

    await expect(
      purgeArchivedProject(project.id, { id: adminId, role: UserRole.ADMIN }, undefined),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      purgeArchivedProject(
        project.id,
        { id: adminId, role: UserRole.ADMIN, viaApiKey: true },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 403 });
    // 无人值守凭证:403 且经 requirePermission 路径写 unattended.denied 审计(codex P2)。
    await expect(
      purgeArchivedProject(
        project.id,
        {
          id: adminId,
          role: UserRole.ADMIN,
          viaApiKey: true,
          unattended: true,
          apiKeyPrefix: 'bma_test',
        },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const deniedAudit = await prisma.auditLog.findFirst({
      where: { operatorId: adminId, action: 'unattended.denied' },
      orderBy: { operatedAt: 'desc' },
    });
    expect(deniedAudit).not.toBeNull();
    const deniedAfter = deniedAudit!.afterData as { attemptedAction?: string };
    expect(deniedAfter?.attemptedAction).toBe('project:delete');
    await expect(
      purgeArchivedProject(project.id, { id: outsiderId, role: UserRole.USER }, undefined),
    ).rejects.toMatchObject({ status: 403 });
    // 预览接口同一套前置。
    await expect(
      getPurgePreview(project.id, { id: outsiderId, role: UserRole.USER }),
    ).rejects.toMatchObject({ status: 403 });

    // 已归档但确认编号不符/缺失 → 422(codex P1:编号确认必须服务端强校验)。
    await archiveProject(project.id, { id: adminId, role: UserRole.ADMIN });
    await expect(
      purgeArchivedProject(project.id, { id: adminId, role: UserRole.ADMIN }, undefined),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      purgeArchivedProject(project.id, { id: adminId, role: UserRole.ADMIN }, `wrong-${code}`),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('purge: 归档项目 → 子数据物理删除 + 审计留痕(projectId SetNull)+ 预览数字正确', async () => {
    const { project, code } = await seedProjectWithRecord();
    await prisma.receiptRecord.create({
      data: {
        id: uuidv7(),
        projectId: project.id,
        receiptDate: new Date('2026-07-01'),
        amount: 100,
        creatorId: adminId,
      },
    });
    await archiveProject(project.id, { id: adminId, role: UserRole.ADMIN });

    const preview = await getPurgePreview(project.id, {
      id: adminId,
      role: UserRole.ADMIN,
    });
    expect(preview.recordCount).toBe(1);
    expect(preview.paidAmount).toBe('500.00');
    expect(preview.totalOccupied).toBe('500.00');
    expect(preview.receiptCount).toBe(1);

    const result = await purgeArchivedProject(
      project.id,
      { id: adminId, role: UserRole.ADMIN },
      code,
    );
    expect(result.recordCount).toBe(1);

    // 数据消失。
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await prisma.businessRecord.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.budgetSubject.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.receiptRecord.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.projectMember.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.projectBudget.count({ where: { projectId: project.id } })).toBe(0);

    // 审计留痕:purge 行保留,projectId 被 FK SetNull,before 快照可追溯。
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'project', objectId: project.id, action: 'purge' },
      orderBy: { operatedAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.projectId).toBeNull();
    const beforeData = audit!.beforeData as { code?: string };
    expect(beforeData?.code).toBe(code);
  });

  it('customStatistics: 归档项目记录不进跨项目分支;显式指定仍可查;purge 后彻底消失', async () => {
    const { project, record } = await seedProjectWithRecord();
    await archiveProject(project.id, { id: adminId, role: UserRole.ADMIN });
    const outsider = { id: outsiderId, role: UserRole.USER };

    // 跨项目分支:排除已归档。
    const cross = await customStatistics({}, outsider);
    expect(cross.records.some((r) => r.id === record.id)).toBe(false);

    // 显式指定归档项目:放行(单项目只读查看)。
    const explicit = await customStatistics({ projectId: project.id }, outsider);
    expect(explicit.records.some((r) => r.id === record.id)).toBe(true);

    // purge 后两条路径都不再有(显式指定已删项目:无 404 语义,但记录为空)。
    await purgeArchivedProject(project.id, { id: adminId, role: UserRole.ADMIN }, project.code);
    const crossAfter = await customStatistics({}, outsider);
    expect(crossAfter.records.some((r) => r.id === record.id)).toBe(false);
    const explicitAfter = await customStatistics({ projectId: project.id }, outsider);
    expect(explicitAfter.records).toHaveLength(0);
  });
});
