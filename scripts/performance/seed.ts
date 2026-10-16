import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaClient, BusinessStatus } from '@prisma/client';
import { v7 as uuid } from 'uuid';

// 合成数据只允许落到显式指定的本机专用库；绝不回落到应用 DATABASE_URL。
const databaseUrl = process.env.PERF_DATABASE_URL;
if (!databaseUrl) throw new Error('必须显式设置 PERF_DATABASE_URL');
const target = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
  !/^\/budget_perf_[a-z0-9_]+$/.test(target.pathname)
) {
  throw new Error('性能夹具仅支持本机 budget_perf_* 专用数据库');
}

const projects = Number(process.env.PERF_PROJECTS ?? 10);
const rowsPerProject = Number(process.env.PERF_ROWS ?? 10_000);
if (!Number.isInteger(projects) || projects < 1 || projects > 100) {
  throw new Error('PERF_PROJECTS 必须在 1–100 之间');
}
if (!Number.isInteger(rowsPerProject) || rowsPerProject < 1 || rowsPerProject > 100_000) {
  throw new Error('PERF_ROWS 必须在 1–100000 之间');
}

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const fixture = {
  version: 1,
  year: 2026,
  rowsPerProject,
  users: [] as { id: string; role: 'ADMIN' | 'USER' }[],
  projects: [] as { id: string; code: string; subjectId: string; recordId: string }[],
};

async function main() {
  try {
    if ((await prisma.user.count()) || (await prisma.project.count())) {
      throw new Error('夹具只写入空库；请创建新的专用库后执行迁移，不自动清空已有数据');
    }
    for (let i = 0; i < 10; i++) {
      const user = { id: uuid(), role: i === 0 ? ('ADMIN' as const) : ('USER' as const) };
      await prisma.user.create({ data: { ...user, name: `性能测试用户${i + 1}` } });
      fixture.users.push(user);
    }
    const statuses = Object.values(BusinessStatus);
    for (let p = 0; p < projects; p++) {
      const projectId = uuid();
      const rootId = uuid();
      const code = `PERF-${String(p + 1).padStart(2, '0')}`;
      const lumpSum = p % 2 === 1;
      await prisma.project.create({
        data: {
          id: projectId,
          code,
          name: `性能项目${p + 1}`,
          ownerId: fixture.users[0].id,
          budgetMode: lumpSum ? 'LUMP_SUM' : 'GENERAL',
          members: {
            create: fixture.users.map((u) => ({ id: uuid(), userId: u.id, memberRole: 'OWNER' })),
          },
          projectBudget: {
            create: { initialAmount: '3000000', currentAmount: '3000000' },
          },
          applications: {
            create: {
              id: uuid(),
              status: 'APPROVED',
              applicantId: fixture.users[0].id,
              approverId: fixture.users[0].id,
              submittedAt: new Date('2024-01-01T00:00:00Z'),
              approvedAt: new Date('2024-01-02T00:00:00Z'),
            },
          },
        },
      });
      await prisma.budgetSubject.create({
        data: { id: rootId, projectId, code: 'ROOT', name: '经费合计', level: 1, isLeaf: false },
      });
      const leaves = Array.from({ length: 20 }, (_, s) => ({
        id: uuid(),
        projectId,
        parentId: rootId,
        code: `S${String(s + 1).padStart(2, '0')}`,
        name: `预算科目${s + 1}`,
        level: 2,
        isLeaf: true,
        sortOrder: s + 1,
      }));
      await prisma.budgetSubject.createMany({ data: leaves });
      if (!lumpSum) {
        await prisma.subjectTotalBudget.createMany({
          data: leaves.map((s) => ({
            id: uuid(),
            projectId,
            subjectId: s.id,
            initialAmount: '150000',
            currentAmount: '150000',
          })),
        });
      }
      for (const year of [2024, 2025, 2026]) {
        await prisma.annualBudget.create({
          data: { id: uuid(), projectId, year, initialAmount: '1000000', currentAmount: '1000000' },
        });
        await prisma.subjectBudget.createMany({
          data: leaves.map((s) => ({
            id: uuid(),
            projectId,
            year,
            subjectId: s.id,
            initialAmount: '50000',
            currentAmount: '50000',
          })),
        });
      }
      let firstRecordId = '';
      for (let offset = 0; offset < rowsPerProject; offset += 1000) {
        const rows = Array.from({ length: Math.min(1000, rowsPerProject - offset) }, (_, n) => {
          const i = offset + n;
          const id = uuid();
          if (i === 0) firstRecordId = id;
          const year = 2024 + (i % 3);
          return {
            id,
            projectId,
            budgetYear: year,
            subjectId: leaves[i % leaves.length].id,
            amount: ((100 + (i % 9900)) / 100).toFixed(2),
            businessDate: new Date(Date.UTC(year, i % 12, 1 + (i % 28))),
            completedDate: i % 4 === 3 ? new Date(Date.UTC(year, i % 12, 28)) : null,
            handler: `经办人${i % 10}`,
            summary: `性能合成业务${i % 40} 编号${i}`,
            status: statuses[i % statuses.length],
            docNo: i % 10 === 0 ? null : `${code}-${i}`,
            remark: i % 5 === 0 ? '合成数据，用于性能验证' : null,
            isVoid: i > 0 && i % 37 === 0,
            createdById: fixture.users[i % fixture.users.length].id,
            createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
          };
        });
        await prisma.businessRecord.createMany({ data: rows });
      }
      await prisma.receiptRecord.create({
        data: {
          id: uuid(),
          projectId,
          receiptDate: new Date('2026-01-01'),
          amount: '1000000',
          summary: '合成到账',
          creatorId: fixture.users[0].id,
        },
      });
      fixture.projects.push({
        id: projectId,
        code,
        subjectId: leaves[0].id,
        recordId: firstRecordId,
      });
    }
    // 不可压缩内容，避免全零 bytea 的压缩使附件读取基线失真。
    await prisma.recordAttachment.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({
        id: uuid(),
        recordId: fixture.projects[0].recordId,
        fileName: `合成凭证${i + 1}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 8 * 1024 * 1024,
        data: randomBytes(8 * 1024 * 1024),
        uploadedById: fixture.users[0].id,
      })),
    });
    await prisma.$executeRaw`ANALYZE`;
    const output = resolve(process.env.PERF_FIXTURE ?? '.scratch/performance/fixture.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(fixture, null, 2) + '\n');
    console.log(
      JSON.stringify({ projects, rowsPerProject, records: projects * rowsPerProject, output }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
