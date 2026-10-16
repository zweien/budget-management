import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessStatus, Prisma, UserRole } from '@prisma/client';
import { prisma, BULK_TX_OPTIONS } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createImportedRecords } from '@/server/services/importRecords.service';

// 验证分块后的真实事务边界和完整审计；第二块失败时第一块也必须消失。
describe('importRecords: 跨块写入与审计原子性 (real PG)', () => {
  const userId = uuidv7();
  const projectId = uuidv7();
  const subjectId = uuidv7();
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, name: 'import-chunks', role: UserRole.ADMIN } });
    await prisma.project.create({
      data: { id: projectId, code: `IC-${uuidv7()}`, name: 'import-chunks', ownerId: userId },
    });
    await prisma.budgetSubject.create({
      data: { id: subjectId, projectId, code: 'A', name: 'A', level: 1, isLeaf: true },
    });
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { projectId } });
    await prisma.businessRecord.deleteMany({ where: { projectId } });
    await prisma.importRow.deleteMany({ where: { batch: { projectId } } });
    await prisma.importBatch.deleteMany({ where: { projectId } });
    await prisma.budgetSubject.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });
  const staged = async () => {
    const batchId = uuidv7();
    const rows = Array.from({ length: 501 }, (_, i) => ({
      data: {
        id: uuidv7(),
        projectId,
        subjectId,
        budgetYear: 2026,
        amount: new Prisma.Decimal('12.34'),
        businessDate: new Date('2026-10-16T00:00:00Z'),
        handler: 'test',
        summary: `${batchId}-${i}`,
        status: BusinessStatus.PLACEHOLDER,
        createdById: userId,
      },
      importRowId: uuidv7(),
      importRowNo: i + 2,
      forcedImport: i === 0,
    }));
    await prisma.importBatch.create({
      data: {
        id: batchId,
        projectId,
        fileName: 'chunks.xlsx',
        templateVersion: '1.0',
        creatorId: userId,
        rows: {
          create: rows.map((r) => ({
            id: r.importRowId,
            rowNo: r.importRowNo,
            parsedData: {},
            validationStatus: 'valid',
            duplicateFlag: r.forcedImport,
          })),
        },
      },
    });
    return { batchId, rows };
  };
  it('跨块新增仍逐条保留实际数据库快照与强制标记', async () => {
    const { batchId, rows } = await staged();
    const ids = await prisma.$transaction(
      (tx) => createImportedRecords(tx, rows, batchId, userId),
      BULK_TX_OPTIONS,
    );
    const [records, audits, forced] = await Promise.all([
      prisma.businessRecord.findMany({ where: { id: { in: ids } } }),
      prisma.auditLog.findMany({ where: { objectId: { in: ids }, action: 'import' } }),
      prisma.importRow.findUniqueOrThrow({ where: { id: rows[0].importRowId } }),
    ]);
    expect(records).toHaveLength(501);
    expect(audits).toHaveLength(501);
    expect(forced.forcedImport).toBe(true);
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const audit of audits) {
      const record = byId.get(audit.objectId)!;
      expect(audit.afterData).toMatchObject({
        id: record.id,
        amount: '12.34',
        businessDate: '2026-10-16',
        createdAt: record.createdAt.toISOString(),
        enteredAt: record.enteredAt.toISOString(),
        completedDate: null,
        isVoid: false,
        importBatchId: batchId,
        createdById: userId,
      });
    }
  });
  it('后续块撞唯一约束时，先前记录、审计、强制标记与批次状态全部回滚', async () => {
    const { batchId, rows } = await staged();
    rows[500].data.id = rows[0].data.id;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.importBatch.update({ where: { id: batchId }, data: { status: 'confirming' } });
        await createImportedRecords(tx, rows, batchId, userId);
        await tx.importBatch.update({ where: { id: batchId }, data: { status: 'confirmed' } });
      }, BULK_TX_OPTIONS),
    ).rejects.toMatchObject({ code: 'P2002' });
    const ids = rows.map((r) => r.data.id);
    expect(await prisma.businessRecord.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { objectId: { in: ids } } })).toBe(0);
    expect(
      (await prisma.importRow.findUniqueOrThrow({ where: { id: rows[0].importRowId } }))
        .forcedImport,
    ).toBe(false);
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe(
      'pending',
    );
  });
});
