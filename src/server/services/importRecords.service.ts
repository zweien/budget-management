import { Prisma } from '@prisma/client';

import { recordAudits } from '@/server/audit/interceptor';

interface ImportedRecord {
  data: Prisma.BusinessRecordCreateManyInput & { id: string; projectId: string };
  importRowId: string;
  importRowNo: number;
  forcedImport: boolean;
}

/**
 * 已复核的新导入行分块写入，整个调用仍处在确认批次的同一个事务中。
 * 读回数据库实际默认值生成完整审计快照；不忽略冲突、不拆分事务。
 */
export async function createImportedRecords(
  tx: Prisma.TransactionClient,
  rows: ImportedRecord[],
  batchId: string,
  operatorId: string,
): Promise<string[]> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await tx.businessRecord.createMany({ data: chunk.map((row) => row.data) });
    const records = await tx.businessRecord.findMany({
      where: { id: { in: chunk.map((row) => row.data.id) } },
    });
    const byId = new Map(records.map((record) => [record.id, record]));
    const forcedIds = chunk.filter((row) => row.forcedImport).map((row) => row.importRowId);
    if (forcedIds.length) {
      await tx.importRow.updateMany({
        where: { id: { in: forcedIds } },
        data: { forcedImport: true },
      });
    }
    await recordAudits(
      tx,
      chunk.map((row) => {
        const record = byId.get(row.data.id);
        if (!record) throw new Error('导入记录写入后未找到，事务已中止');
        return {
          projectId: row.data.projectId,
          objectType: 'business_records',
          objectId: record.id,
          action: 'import',
          operatorId,
          after: {
            ...record,
            amount: record.amount.toFixed(2),
            businessDate: record.businessDate.toISOString().slice(0, 10),
            importBatchId: batchId,
            importRowNo: row.importRowNo,
            forcedImport: row.forcedImport,
          },
        };
      }),
    );
  }
  return rows.map((row) => row.data.id);
}
