import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { checkDuplicates } from '@/server/services/duplicateCheck.service';

/**
 * 统一查重判定器集成测试(直连真实 PG):docNo 硬重复(库内/批内)、
 * 指纹疑似(归一化摘要)、作废记录不参与判定、编辑排除自身。
 */
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('duplicateCheck.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let projectId: string;
  let leafId: string;

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'dup-admin', role: UserRole.ADMIN },
    });
    createdUserIds.push(adminId);
    const project = await createProject(
      { code: `DUP-${uuidv7().slice(-12)}`, name: 'dup test' },
      { id: adminId, role: UserRole.ADMIN },
    );
    projectId = project.id;
    createdProjectIds.push(projectId);
    leafId = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: leafId,
        projectId,
        parentId: null,
        code: 'D1',
        name: '查重科目',
        level: 1,
        isLeaf: true,
      },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function seedRecord(
    over: { docNo?: string | null; summary?: string; isVoid?: boolean } = {},
  ) {
    return prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        budgetYear: 2026,
        subjectId: leafId,
        amount: new Prisma.Decimal('100.00'),
        businessDate: new Date('2026-08-01T00:00:00Z'),
        handler: '张三',
        summary: '基准摘要',
        status: BusinessStatus.PAID,
        createdById: adminId,
        ...over,
      },
    });
  }

  it('docNo 命中未作废记录 → hard + 冲突详情;作废记录不占编号', async () => {
    const rec = await seedRecord({ docNo: 'DUP-001' });
    const [hit] = await checkDuplicates(projectId, [
      {
        rowKey: 'r1',
        docNo: 'DUP-001',
        budgetYear: 2026,
        amount: '1.00',
        businessDate: '2026-08-02',
        summary: '别的',
      },
    ]);
    expect(hit.hard).toBe(true);
    expect(hit.hardSource).toBe('db');
    expect(hit.conflicts[0]?.recordId).toBe(rec.id);

    // 作废后编号释放:不再判硬重复。
    await prisma.businessRecord.update({ where: { id: rec.id }, data: { isVoid: true } });
    const [afterVoid] = await checkDuplicates(projectId, [
      {
        rowKey: 'r1',
        docNo: 'DUP-001',
        budgetYear: 2026,
        amount: '1.00',
        businessDate: '2026-08-02',
        summary: '别的',
      },
    ]);
    expect(afterVoid.hard).toBe(false);
  });

  it('批内同号:第 2 次出现 → hard(inFile),并指向首次出现行', async () => {
    const [a, b] = await checkDuplicates(projectId, [
      {
        rowKey: 'first',
        docNo: 'INFILE-1',
        budgetYear: 2026,
        amount: '5.00',
        businessDate: '2026-08-01',
        summary: 'x',
      },
      {
        rowKey: 'second',
        docNo: 'INFILE-1',
        budgetYear: 2026,
        amount: '5.00',
        businessDate: '2026-08-01',
        summary: 'x',
      },
    ]);
    expect(a.hard).toBe(false);
    expect(b.hard).toBe(true);
    expect(b.hardSource).toBe('inFile');
    expect(b.inFileDupOf).toBe('first');
  });

  it('无编号行走指纹:命中 → suspected;摘要空白归一化后仍命中;不同摘要不误报', async () => {
    await seedRecord({ summary: '  培训费   ' });
    const [hit, hitNormalized, miss] = await checkDuplicates(projectId, [
      {
        rowKey: 'h1',
        docNo: null,
        budgetYear: 2026,
        amount: '100.00',
        businessDate: '2026-08-01',
        summary: '培训费',
      },
      {
        rowKey: 'h2',
        docNo: null,
        budgetYear: 2026,
        amount: '100.00',
        businessDate: '2026-08-01',
        summary: ' 培训费  ',
      },
      {
        rowKey: 'm1',
        docNo: null,
        budgetYear: 2026,
        amount: '100.00',
        businessDate: '2026-08-01',
        summary: '别的支出',
      },
    ]);
    expect(hit.suspected).toBe(true);
    expect(hitNormalized.suspected).toBe(true);
    expect(miss.suspected).toBe(false);
    expect(miss.hard).toBe(false);
  });

  it('有编号的行走 docNo 判定,不参与指纹(同指纹不同编号 → 不疑似)', async () => {
    await seedRecord({ docNo: 'BASE-9' });
    const [r] = await checkDuplicates(projectId, [
      {
        rowKey: 'r1',
        docNo: 'OTHER-9',
        budgetYear: 2026,
        amount: '100.00',
        businessDate: '2026-08-01',
        summary: '基准摘要',
      },
    ]);
    expect(r.hard).toBe(false);
    expect(r.suspected).toBe(false);
  });

  it('excludeRecordId:编辑场景排除自身', async () => {
    const rec = await seedRecord({ docNo: 'SELF-1' });
    const [self] = await checkDuplicates(
      projectId,
      [
        {
          rowKey: 'self',
          docNo: 'SELF-1',
          budgetYear: 2026,
          amount: '100.00',
          businessDate: '2026-08-01',
          summary: '基准摘要',
        },
      ],
      { excludeRecordId: rec.id },
    );
    expect(self.hard).toBe(false);
    expect(self.suspected).toBe(false);
  });

  it('DB 部分唯一索引兜底:同项目同号未作废插入被拒;作废后可插', async () => {
    await seedRecord({ docNo: 'IDX-1' });
    await expect(
      prisma.businessRecord.create({
        data: {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: new Prisma.Decimal('2.00'),
          businessDate: new Date('2026-08-02T00:00:00Z'),
          handler: '李四',
          summary: '撞号记录',
          status: BusinessStatus.PAID,
          docNo: 'IDX-1',
          createdById: adminId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // 作废首条(释放编号)后可插入。
    const first = await prisma.businessRecord.findFirstOrThrow({
      where: { projectId, docNo: 'IDX-1' },
    });
    await prisma.businessRecord.update({ where: { id: first.id }, data: { isVoid: true } });
    const second = await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        budgetYear: 2026,
        subjectId: leafId,
        amount: new Prisma.Decimal('2.00'),
        businessDate: new Date('2026-08-02T00:00:00Z'),
        handler: '李四',
        summary: '重导记录',
        status: BusinessStatus.PAID,
        docNo: 'IDX-1',
        createdById: adminId,
      },
    });
    expect(second.docNo).toBe('IDX-1');
  });
});
