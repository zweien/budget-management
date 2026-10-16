import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PrismaClient } from '@prisma/client';

const databaseUrl = new URL(process.env.PERF_DATABASE_URL ?? '');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) &&
    /^\/budget_perf_[a-z0-9_]+$/.test(databaseUrl.pathname),
  '只读核对仅允许专用合成库',
);
const prisma = new PrismaClient({ datasourceUrl: databaseUrl.href });
const result = { capturedAt: new Date().toISOString(), label: process.env.PERF_LABEL, batches: [] };
try {
  const batches = await prisma.importBatch.findMany({
    where: { status: 'confirmed', fileName: { startsWith: 'performance-' } },
    select: { id: true, createdCount: true, updatedCount: true },
  });
  assert.ok(batches.length > 0, '先运行含确认入账的合成负载');
  for (const batch of batches) {
    const audits = await prisma.auditLog.findMany({
      where: { action: 'import', afterData: { path: ['importBatchId'], equals: batch.id } },
      select: { objectId: true },
    });
    const ids = [...new Set(audits.map((audit) => audit.objectId))];
    const records = await prisma.businessRecord.count({ where: { id: { in: ids } } });
    assert.equal(audits.length, batch.createdCount);
    assert.equal(ids.length, batch.createdCount);
    assert.equal(records, batch.createdCount);
    result.batches.push({
      batchId: batch.id,
      created: batch.createdCount,
      updated: batch.updatedCount,
      audits: audits.length,
      records,
      matched: true,
    });
  }
  result.totalRecords = await prisma.businessRecord.count();
  const attachments = await prisma.recordAttachment.aggregate({
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
  result.attachments = { count: attachments._count._all, bytes: attachments._sum.sizeBytes };
} finally {
  await prisma.$disconnect();
}
const output = process.env.PERF_OUTPUT ?? '.scratch/performance/audit.json';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    batches: result.batches.length,
    totalRecords: result.totalRecords,
    attachments: result.attachments,
    matched: true,
  }),
);
