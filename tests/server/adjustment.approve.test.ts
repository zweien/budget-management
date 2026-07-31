import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApprovalStatus, BusinessStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { fromStored } from '@/lib/decimal';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';
import { createRecord } from '@/server/services/businessRecord.service';
import {
  approveAdjustment,
  createAdjustment,
  rejectAdjustment,
  submitAdjustment,
  withdrawAdjustment,
} from '@/server/services/adjustment.service';
import { HTTPError } from '@/lib/auth/session';

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.budgetLock.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetAdjustmentLine
    .deleteMany({ where: { adjustment: { projectId } } })
    .catch(() => {});
  await prisma.budgetAdjustment.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.businessRecordHistory
    .deleteMany({ where: { businessRecord: { projectId } } })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

/**
 * 合法编制:1 根 + 2 叶(A/B),2026 年度。A=600、B=400。
 * 总预算:A=600、B=400。
 */
function validBudgetPayload(): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [{ year: 2026, amount: '1000.00' }],
    subjects: [
      { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
      { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
      { code: 'B', name: '叶B', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      {
        year: 2026,
        subjectCode: 'A',
        amount: '600.00',
        unit: '次',
        quantity: '6.00',
        unitPrice: '100.00',
      },
      {
        year: 2026,
        subjectCode: 'B',
        amount: '400.00',
        unit: '次',
        quantity: '4.00',
        unitPrice: '100.00',
      },
    ],
    subjectTotalBudgets: [
      { subjectCode: 'A', amount: '600.00' },
      { subjectCode: 'B', amount: '400.00' },
    ],
  };
}

async function expectHTTP(fn: () => Promise<unknown>, status: number): Promise<void> {
  try {
    await fn();
    throw new Error('应抛 HTTPError 但未抛');
  } catch (e) {
    expect((e as HTTPError).status).toBe(status);
  }
}

describe('adjustment.approve (integration, real PG) — 双维度生效', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-apv', role: UserRole.BUDGET_ADMIN },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:建项目 + 编制 + 审批 → { project, leafA, leafB }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `APV-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `apv ${suffix}` }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validBudgetPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    return {
      project,
      leafA: subjects.find((s) => s.code === 'A')!,
      leafB: subjects.find((s) => s.code === 'B')!,
    };
  }

  it('approveAdjustment: 双维度同步生效(A 总-100/年-100,B 总+100/年+100)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('OK');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const approved = await approveAdjustment(adj.id, adminUser(), '同意');
    expect(approved.status).toBe(ApprovalStatus.APPROVED);

    // 年度维度:SubjectBudget.currentAmount。A 600→500;B 400→500。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    const sbB = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafB.id },
      },
    });
    expect(fromStored(sbA!.currentAmount).toFixed(2)).toBe('500.00');
    expect(fromStored(sbB!.currentAmount).toFixed(2)).toBe('500.00');
    // adjustmentAmount 同步累加。
    expect(fromStored(sbA!.adjustmentAmount).toFixed(2)).toBe('-100.00');

    // 总预算维度:SubjectTotalBudget.currentAmount。A 600→500;B 400→500。
    const stbA = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    const stbB = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafB.id } },
    });
    expect(fromStored(stbA!.currentAmount).toFixed(2)).toBe('500.00');
    expect(fromStored(stbB!.currentAmount).toFixed(2)).toBe('500.00');

    // 锁已释放。
    const locks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id, releasedAt: null },
    });
    expect(locks).toHaveLength(0);
  });

  it('approveAdjustment: 仅调总预算维度(年度全0),总预算生效、年度不变', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('TOTONLY');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '0.00' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '0.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser(), '仅调总预算');

    // 年度维度不变:A 仍 600,B 仍 400。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    expect(fromStored(sbA!.currentAmount).toFixed(2)).toBe('600.00');
    // 总预算维度:A 600→500。
    const stbA = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    expect(fromStored(stbA!.currentAmount).toFixed(2)).toBe('500.00');
  });

  it('approveAdjustment: §7.5 提交后新增业务占用导致可调额度不足 → 422,状态仍 PENDING', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('OCC');
    // 先建调整单(A 调减 500,可调 600)并提交写锁。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-500.00', annualAdjustment: '-500.00' },
          { subjectId: leafB.id, totalAdjustment: '500.00', annualAdjustment: '500.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    // 提交后:在 A 上登记一笔 300 业务占用(可调额度 600→300 < 500)。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '300.00',
        businessDate: '2026-06-01',
        status: BusinessStatus.CONTRACT,
        handler: '张三',
        summary: '占额度',
        remark: null,
      },
      adminUser(),
    );

    // 审批时重新校验可调额度(600-300=300 < 500)→ 422。
    await expectHTTP(() => approveAdjustment(adj.id, adminUser(), '同意'), 422);
    const after = await prisma.budgetAdjustment.findUnique({ where: { id: adj.id } });
    expect(after!.status).toBe(ApprovalStatus.PENDING);
    // 锁未释放。
    const locks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id, releasedAt: null },
    });
    expect(locks.length).toBeGreaterThan(0);
  });

  it('approveAdjustment: §7.4 生效后 current < 占用 → 422(安全护栏)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('SAFETY');
    // 先在 A 登记一笔 200 占用。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '200.00',
        businessDate: '2026-06-01',
        status: BusinessStatus.PAID,
        handler: '张三',
        summary: '已支出',
        remark: null,
      },
      adminUser(),
    );

    // A 调减 500(A 当前 600,可调 600-200=400 < 500) → 提交时就 422。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-500.00', annualAdjustment: '-500.00' },
          { subjectId: leafB.id, totalAdjustment: '500.00', annualAdjustment: '500.00' },
        ],
      },
      adminUser(),
    );
    await expectHTTP(() => submitAdjustment(adj.id, adminUser()), 422);
  });

  it('rejectAdjustment: PENDING → REJECTED,释放锁,不改 current', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('REJ');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const rejected = await rejectAdjustment(adj.id, adminUser(), '不同意');
    expect(rejected.status).toBe(ApprovalStatus.REJECTED);

    // current 不变。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    expect(fromStored(sbA!.currentAmount).toFixed(2)).toBe('600.00');
    // 锁已释放。
    const locks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id, releasedAt: null },
    });
    expect(locks).toHaveLength(0);
  });

  it('rejectAdjustment: 缺意见 → 422', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('REJNOPIN');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    await expectHTTP(() => rejectAdjustment(adj.id, adminUser(), ''), 422);
  });

  it('withdrawAdjustment: PENDING → DRAFT,释放锁', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('WD');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const withdrawn = await withdrawAdjustment(adj.id, adminUser());
    expect(withdrawn.status).toBe(ApprovalStatus.DRAFT);
    const locks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id, releasedAt: null },
    });
    expect(locks).toHaveLength(0);
  });
});
