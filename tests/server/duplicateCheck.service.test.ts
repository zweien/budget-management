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
  let captureCandidates = false;
  const candidateCounts: number[] = [];

  beforeAll(async () => {
    await prisma.$connect();
    prisma.$use(async (params, next) => {
      const result = await next(params);
      if (captureCandidates && params.model === 'BusinessRecord' && params.action === 'findMany') {
        candidateCounts.push(result.length);
      }
      return result;
    });
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

  it('无编号查重只取相同日期/金额候选，保留摘要归一化与既有编号记录的提示', async () => {
    await prisma.businessRecord.createMany({
      data: Array.from({ length: 100 }, () => ({
        id: uuidv7(),
        projectId,
        subjectId: leafId,
        budgetYear: 2026,
        amount: '321.00',
        businessDate: new Date('2026-08-02'),
        handler: '测试',
        summary: '无关候选',
        status: BusinessStatus.PAID,
        createdById: adminId,
      })),
    });
    const hit = await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        subjectId: leafId,
        budgetYear: 2026,
        amount: '345.67',
        businessDate: new Date('2026-08-02'),
        handler: '测试',
        summary: '  候选\t摘要  ',
        docNo: 'FP-EXISTING',
        status: BusinessStatus.PAID,
        createdById: adminId,
      },
    });
    candidateCounts.length = 0;
    captureCandidates = true;
    try {
      const [verdict] = await checkDuplicates(projectId, [
        {
          rowKey: 'candidate',
          docNo: null,
          budgetYear: 2026,
          amount: '345.67',
          businessDate: '2026-08-02',
          summary: '候选 摘要',
        },
      ]);
      expect(verdict.suspected).toBe(true);
      expect(verdict.conflicts[0].recordId).toBe(hit.id);
      expect(candidateCounts).toEqual([1]);
    } finally {
      captureCandidates = false;
    }
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

  it.each([
    [500, 1],
    [501, 1],
    [1, 500],
    [1, 501],
    [501, 501],
  ])('金额种类%d/日期种类%d的边界批次仍能命中末行', async (amountKinds, dateKinds) => {
    const summary = `大批次${amountKinds}/${dateKinds} 末行`;
    const rec = await seedRecord({ summary });
    const rows = Array.from({ length: Math.max(amountKinds, dateKinds) - 1 }, (_, i) => ({
      rowKey: `large-${i}`,
      docNo: null,
      budgetYear: 2026,
      amount: amountKinds === 1 ? '100.00' : `${200 + i}.00`,
      businessDate:
        dateKinds === 1
          ? '2026-08-01'
          : new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10),
      summary: `无关 ${i}`,
    }));
    rows.push({
      rowKey: 'last',
      docNo: null,
      budgetYear: 2026,
      amount: '100.00',
      businessDate: '2026-08-01',
      summary: ` 大批次${amountKinds}/${dateKinds}\t末行 `,
    });
    const results = await checkDuplicates(projectId, rows);
    expect(results).toHaveLength(rows.length);
    expect(results.at(-1)?.suspected).toBe(true);
    expect(results.at(-1)?.conflicts[0].recordId).toBe(rec.id);
    expect(results.slice(0, -1).every((r) => !r.suspected && !r.hard)).toBe(true);
  });

  it.each([
    ['bad', '2026-08-01'],
    ['100.00', 'invalid-date'],
  ])('混有非规范字段%s/%s时仍检查其他有效行', async (amount, businessDate) => {
    await seedRecord({ summary: '混合有效行' });
    const results = await checkDuplicates(projectId, [
      {
        rowKey: 'valid',
        docNo: null,
        budgetYear: 2026,
        amount: '100.00',
        businessDate: '2026-08-01',
        summary: '混合有效行',
      },
      {
        rowKey: 'invalid',
        docNo: null,
        budgetYear: 2026,
        amount,
        businessDate,
        summary: '混合有效行',
      },
    ]);
    expect(results[0].suspected).toBe(true);
    expect(results[1].suspected).toBe(false);
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
