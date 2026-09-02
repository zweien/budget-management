import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { getSubjectMappings, normalizeSummary } from '@/server/services/subjectMapping.service';

/**
 * 科目映射记忆集成测试(直连真实 PG):业务记录的「摘要→科目」历史统计、
 * 归一化合并、作废排除、q 过滤与排序。供 agent 导入自动指派科目。
 */
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('subjectMapping.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-map', role: UserRole.ADMIN },
    });
    createdUserIds.push(adminId);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function seedRecord(
    projectId: string,
    subjectId: string,
    summary: string,
    opts: { isVoid?: boolean } = {},
  ) {
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        budgetYear: 2026,
        subjectId,
        amount: new Prisma.Decimal('100.00'),
        businessDate: new Date('2026-08-01'),
        handler: '张三',
        summary,
        status: BusinessStatus.PAID,
        isVoid: opts.isVoid ?? false,
        createdById: adminId,
      },
    });
  }

  it('归一化合并 + 作废排除 + 排序 + 科目信息回填', async () => {
    const code = `MAP-${uuidv7().slice(-12)}`;
    const project = await createProject(
      { code, name: 'map test' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const l1 = uuidv7();
    const l2 = uuidv7();
    await prisma.budgetSubject.createMany({
      data: [
        {
          id: l1,
          projectId: project.id,
          parentId: null,
          code: '301',
          name: '租车费',
          level: 1,
          isLeaf: true,
        },
        {
          id: l2,
          projectId: project.id,
          parentId: null,
          code: '302',
          name: '数据服务费',
          level: 1,
          isLeaf: true,
        },
      ],
    });

    // 「租车费」→ 301:3 条(含空白写法差异,归一化后合并)
    await seedRecord(project.id, l1, '租车费');
    await seedRecord(project.id, l1, ' 租车费  ');
    await seedRecord(project.id, l1, '租车费 ');
    // 「数据服务费」→ 302:1 条
    await seedRecord(project.id, l2, '数据服务费');
    // 作废的「租车费」→ 302:4 条;若 isVoid 过滤失效,L2 会以 4>3 反超
    for (let i = 0; i < 4; i++) {
      await seedRecord(project.id, l2, '租车费', { isVoid: true });
    }

    const mappings = await getSubjectMappings(project.id);
    expect(mappings).toHaveLength(2);
    // 按使用次数降序:租车费(3)在前,且科目信息已回填
    expect(mappings[0]).toMatchObject({
      summary: '租车费',
      subjectId: l1,
      subjectCode: '301',
      subjectName: '租车费',
      useCount: 3,
    });
    expect(mappings[1]).toMatchObject({
      summary: '数据服务费',
      subjectId: l2,
      subjectCode: '302',
      useCount: 1,
    });
  });

  it('q 过滤(不区分大小写包含)', async () => {
    const code = `MAP-${uuidv7().slice(-12)}`;
    const project = await createProject(
      { code, name: 'map q test' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const l1 = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: l1,
        projectId: project.id,
        parentId: null,
        code: '401',
        name: 'Test费',
        level: 1,
        isLeaf: true,
      },
    });
    await seedRecord(project.id, l1, 'Testdata 数据费');
    await seedRecord(project.id, l1, '差旅费');

    const hit = await getSubjectMappings(project.id, { q: 'testdata' });
    expect(hit).toHaveLength(1);
    expect(hit[0].summary).toBe('Testdata 数据费');
    const none = await getSubjectMappings(project.id, { q: '不存在的摘要' });
    expect(none).toHaveLength(0);
  });

  it('normalizeSummary:去首尾空白 + 压缩连续空白', () => {
    expect(normalizeSummary('  a   b  ')).toBe('a b');
    expect(normalizeSummary('')).toBe('');
  });
});
