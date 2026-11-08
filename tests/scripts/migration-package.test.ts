/**
 * 迁移包导出/导入集成测试(真实 PG,ADR 0003)。
 * 覆盖:导出字段与守卫、User 引用重映射/占位、同编号冲突、--overwrite 骨架态守卫、
 * 汇总漂移自动修复、--owner 认领与歧义拒绝、版本守卫。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { prisma } from '@/lib/prisma';
import {
  exportPackage,
  importPackage,
  deleteProjectCascade,
  type MigrationPackage,
} from '@/server/services/migrationPackage.service';

const NAME_ADMIN = `mig-admin-${uuidv7().slice(0, 8)}`;
const NAME_USER = `mig-user-${uuidv7().slice(0, 8)}`;
const NAME_DUP = `mig-dup-${uuidv7().slice(0, 8)}`;

let adminId: string;
let userId: string;
let dup1: string;
let dup2: string;
let pkg1: MigrationPackage;

interface SeedResult {
  projectId: string;
  code: string;
  subjectIds: { root: string; leaf1: string; leaf2: string };
  adjustmentId: string;
  initialAppId: string;
}

/** 直接以 prisma 造一套自洽的「项目+预算骨架」(GENERAL,科目层 Σ = 汇总层)。 */
async function seedProject(
  code: string,
  opts: { adjustmentStatus?: 'APPROVED' | 'PENDING' } = {},
): Promise<SeedResult> {
  const projectId = uuidv7();
  const root = uuidv7();
  const leaf1 = uuidv7();
  const leaf2 = uuidv7();
  const initialAppId = uuidv7();
  const adjustmentId = uuidv7();
  const now = new Date();

  await prisma.project.create({
    data: {
      id: projectId,
      code,
      name: `迁移测试 ${code}`,
      ownerId: adminId,
      budgetMode: 'GENERAL',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2028-12-31'),
    },
  });
  await prisma.budgetSubject.createMany({
    data: [
      {
        id: root,
        projectId,
        parentId: null,
        code: 'A',
        name: '直接费用',
        level: 0,
        isLeaf: false,
        sortOrder: 0,
      },
      {
        id: leaf1,
        projectId,
        parentId: root,
        code: 'A01',
        name: '设备费',
        level: 1,
        isLeaf: true,
        sortOrder: 0,
      },
      {
        id: leaf2,
        projectId,
        parentId: root,
        code: 'A02',
        name: '材料费',
        level: 1,
        isLeaf: true,
        sortOrder: 1,
      },
    ],
  });
  await prisma.projectBudget.create({
    data: { projectId, initialAmount: '10.00', adjustmentAmount: '2.00', currentAmount: '12.00' },
  });
  await prisma.annualBudget.create({
    data: {
      id: uuidv7(),
      projectId,
      year: 2026,
      initialAmount: '10.00',
      adjustmentAmount: '2.00',
      currentAmount: '12.00',
    },
  });
  await prisma.subjectBudget.createMany({
    data: [
      {
        id: uuidv7(),
        projectId,
        year: 2026,
        subjectId: leaf1,
        initialAmount: '6.00',
        adjustmentAmount: '2.00',
        currentAmount: '8.00',
      },
      {
        id: uuidv7(),
        projectId,
        year: 2026,
        subjectId: leaf2,
        initialAmount: '4.00',
        adjustmentAmount: '0.00',
        currentAmount: '4.00',
      },
    ],
  });
  await prisma.subjectTotalBudget.createMany({
    data: [
      {
        id: uuidv7(),
        projectId,
        subjectId: leaf1,
        initialAmount: '6.00',
        adjustmentAmount: '2.00',
        currentAmount: '8.00',
      },
      {
        id: uuidv7(),
        projectId,
        subjectId: leaf2,
        initialAmount: '4.00',
        adjustmentAmount: '0.00',
        currentAmount: '4.00',
      },
    ],
  });
  await prisma.initialBudgetApplication.create({
    data: {
      id: initialAppId,
      projectId,
      status: 'APPROVED',
      applicantId: adminId,
      submittedAt: now,
      approverId: userId,
      approvedAt: now,
    },
  });
  await prisma.budgetAdjustment.create({
    data: {
      id: adjustmentId,
      projectId,
      year: 2026,
      kind: 'ADJUST',
      status: opts.adjustmentStatus ?? 'APPROVED',
      applicantId: adminId,
      approverId: userId,
      approvedAt: opts.adjustmentStatus === 'PENDING' ? null : now,
      submittedAt: now,
    },
  });
  await prisma.budgetAdjustmentLine.create({
    data: {
      id: uuidv7(),
      adjustmentId,
      year: 2026,
      subjectId: leaf2,
      totalAdjustment: '2.00',
      annualAdjustment: '2.00',
    },
  });
  await prisma.subjectChangeApplication.create({
    data: {
      id: uuidv7(),
      projectId,
      status: 'APPROVED',
      beforeSnapshot: { subjects: [] },
      afterSnapshot: { subjects: [{ code: 'A02', name: '材料费' }] },
      applicantId: adminId,
      approverId: userId,
    },
  });
  return { projectId, code, subjectIds: { root, leaf1, leaf2 }, adjustmentId, initialAppId };
}

/** 按依赖序彻底删除项目(与导入 --overwrite 同一实现,防依赖序两处漂移)。 */
async function deleteProjectFully(projectId: string): Promise<void> {
  await prisma.$transaction((tx) => deleteProjectCascade(tx, projectId)).catch(() => {});
}

async function deleteUser(id: string): Promise<void> {
  await prisma.user.deleteMany({ where: { id } }).catch(() => {});
}

async function reseedUsers(): Promise<void> {
  adminId = uuidv7();
  userId = uuidv7();
  await prisma.user.createMany({
    data: [
      { id: adminId, name: NAME_ADMIN, role: 'ADMIN' },
      { id: userId, name: NAME_USER, role: 'USER' },
    ],
  });
}

describe('migrationPackage.service(集成,真实 PG)', () => {
  // 注意不能用 uuidv7().slice(0,8):uuidv7 前缀是毫秒时间戳,相邻调用同毫秒会撞码。
  const code1 = `MIG-${uuidv7()}`;
  const code2 = `MIG-${uuidv7()}`;

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    userId = uuidv7();
    dup1 = uuidv7();
    dup2 = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: NAME_ADMIN, role: 'ADMIN' },
        { id: userId, name: NAME_USER, role: 'USER' },
        { id: dup1, name: NAME_DUP, role: 'USER' },
        { id: dup2, name: NAME_DUP, role: 'USER' },
      ],
    });
  });

  afterAll(async () => {
    for (const p of await prisma.project.findMany({ where: { code: { startsWith: 'MIG-' } } })) {
      await deleteProjectFully(p.id);
    }
    for (const id of [adminId, userId, dup1, dup2]) await deleteUser(id);
    await prisma.$disconnect();
  });

  it('exportPackage:envelope、字段、Decimal 字符串与来源附注', { timeout: 60_000 }, async () => {
    const seed = await seedProject(code1);
    pkg1 = await exportPackage(code1);
    expect(pkg1.formatVersion).toBe(1);
    expect(pkg1.kind).toBe('budget.migration-package');
    expect(pkg1.project.code).toBe(code1);
    expect(pkg1.project.ownerId).toBe(adminId);
    expect(pkg1.subjects).toHaveLength(3);
    expect(pkg1.subjects.map((s) => s.code).sort()).toEqual(['A', 'A01', 'A02']);
    expect(pkg1.projectBudget).toMatchObject({
      initialAmount: '10.00',
      adjustmentAmount: '2.00',
      currentAmount: '12.00',
    });
    expect(pkg1.subjectBudgets.map((s) => s.initialAmount).sort()).toEqual(['4.00', '6.00']);
    expect(pkg1.adjustments).toHaveLength(1);
    expect(pkg1.adjustments[0].lines).toHaveLength(1);
    expect(pkg1.subjectChanges).toHaveLength(1);
    expect(pkg1.provenance.sourceOwner).toMatchObject({ userId: adminId, userName: NAME_ADMIN });
    expect(pkg1.provenance.userRefs.length).toBeGreaterThanOrEqual(2); // owner + 审批人
    await deleteProjectFully(seed.projectId);
  });

  it(
    'importPackage:源用户不存在时必填引用重映射占位、可空置空,单事务落数且 ID 保留',
    { timeout: 60_000 },
    async () => {
      // 模拟跨环境:源用户(与引用)在本库不存在。
      await deleteUser(adminId);
      await deleteUser(userId);

      const earliestAdmin = await prisma.user.findFirst({
        where: { role: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
      });
      expect(earliestAdmin).not.toBeNull();

      const report = await importPackage(pkg1, {});
      expect(report.projectCode).toBe(code1);
      expect(report.owner.mode).toBe('placeholder');
      expect(report.warnings.join(' ')).toContain('占位');

      const project = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
      expect(project.id).toBe(pkg1.project.id);
      expect(project.ownerId).toBe(earliestAdmin!.id);

      const initApp = await prisma.initialBudgetApplication.findUniqueOrThrow({
        where: { projectId: project.id },
      });
      expect(initApp.id).toBe(pkg1.initialApplication!.id);
      expect(initApp.applicantId).toBe(earliestAdmin!.id); // 必填→重映射
      expect(initApp.approverId).toBeNull(); // 可空→置空

      const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
      expect(subjects.map((s) => s.id).sort()).toEqual(pkg1.subjects.map((s) => s.id).sort());

      const pb = await prisma.projectBudget.findUniqueOrThrow({ where: { projectId: project.id } });
      expect(pb.initialAmount.toFixed(2)).toBe('10.00');
      expect(pb.currentAmount.toFixed(2)).toBe('12.00');

      // 占位模式不建成员关系。
      expect(await prisma.projectMember.count({ where: { projectId: project.id } })).toBe(0);
      // 汇总自洽:不触发修复。
      expect(report.summaryCheck.fixed).toBe(false);

      await reseedUsers();
    },
  );

  it(
    '同编号二次导入:默认冲突拒绝;--overwrite 骨架态替换成功且边界透明(成员移除入 warnings)',
    { timeout: 60_000 },
    async () => {
      await expect(importPackage(pkg1, {})).rejects.toMatchObject({ name: 'MigrationError' });
      // 目标侧先挂一个成员:骨架态允许覆盖,但移除必须出现在 warnings。
      const existing = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
      await prisma.projectMember.create({
        data: { id: uuidv7(), projectId: existing.id, userId, memberRole: 'OWNER' },
      });
      const report = await importPackage(pkg1, { overwrite: true });
      expect(report.replacedExisting).toBe(true);
      expect(report.warnings.join(' ')).toContain('成员关系 1 条');
      const project = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
      expect(await prisma.projectMember.count({ where: { projectId: project.id } })).toBe(0);
      expect(project.name).toContain(code1);
    },
  );

  it('--overwrite 骨架态守卫:目标已有业务记录时硬拒绝(无绕过)', { timeout: 60_000 }, async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
    const leaf = await prisma.budgetSubject.findFirstOrThrow({
      where: { projectId: project.id, isLeaf: true },
    });
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId: project.id,
        budgetYear: 2026,
        subjectId: leaf.id,
        amount: '1.00',
        businessDate: new Date(),
        handler: 't',
        summary: '骨架态守卫测试',
        status: 'PLACEHOLDER',
        createdById: adminId,
      },
    });
    await expect(importPackage(pkg1, { overwrite: true })).rejects.toMatchObject({
      name: 'MigrationError',
      message: expect.stringContaining('骨架态'),
    });
    await prisma.businessRecord.deleteMany({ where: { projectId: project.id } });
  });

  it('汇总漂移:篡改包内汇总行后导入,按科目层 Σ 自动修复', { timeout: 60_000 }, async () => {
    const tampered = structuredClone(pkg1);
    tampered.projectBudget!.initialAmount = '999.00';
    tampered.annualBudgets[0].initialAmount = '999.00';
    const report = await importPackage(tampered, { overwrite: true });
    expect(report.summaryCheck.fixed).toBe(true);
    const project = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
    const pb = await prisma.projectBudget.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(pb.initialAmount.toFixed(2)).toBe('10.00');
    expect(pb.currentAmount.toFixed(2)).toBe('12.00');
    const ab = await prisma.annualBudget.findFirstOrThrow({ where: { projectId: project.id } });
    expect(ab.initialAmount.toFixed(2)).toBe('10.00');
  });

  it('PENDING 导出守卫:默认拒绝,--force 带出', { timeout: 60_000 }, async () => {
    const seed = await seedProject(code2, { adjustmentStatus: 'PENDING' });
    await expect(exportPackage(code2)).rejects.toMatchObject({
      name: 'MigrationError',
      message: expect.stringContaining('PENDING'),
    });
    const forced = await exportPackage(code2, { force: true });
    expect(forced.provenance.pending.adjustments).toHaveLength(1);
    await deleteProjectFully(seed.projectId);
  });

  it('--owner 认领:严格查找命中,建 OWNER 成员并重映射必填引用', { timeout: 60_000 }, async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
    await deleteProjectFully(project.id);
    const report = await importPackage(pkg1, { ownerKey: NAME_USER });
    expect(report.owner).toMatchObject({ mode: 'claimed', userId });
    const imported = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
    expect(imported.ownerId).toBe(userId);
    const member = await prisma.projectMember.findFirst({
      where: { projectId: imported.id, userId },
    });
    expect(member?.memberRole).toBe('OWNER');
  });

  it('--owner 歧义拒绝:同名多用户列出候选且不动库', { timeout: 60_000 }, async () => {
    await expect(importPackage(pkg1, { ownerKey: NAME_DUP })).rejects.toMatchObject({
      name: 'MigrationError',
      message: expect.stringContaining('歧义'),
    });
  });

  it('版本守卫:包版本不一致默认拒绝,--allow-skew 放行', { timeout: 60_000 }, async () => {
    const skewed = structuredClone(pkg1);
    skewed.appVersion = '0.0.0';
    await expect(importPackage(skewed, {})).rejects.toMatchObject({
      name: 'MigrationError',
      message: expect.stringContaining('版本不一致'),
    });
    const project = await prisma.project.findUniqueOrThrow({ where: { code: code1 } });
    await deleteProjectFully(project.id);
    const report = await importPackage(skewed, { allowSkew: true, ownerKey: NAME_USER });
    expect(report.projectCode).toBe(code1);
  });
});
