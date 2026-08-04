import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApprovalStatus, UserRole } from '@prisma/client';

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
import {
  createAdjustment,
  deleteDraftAdjustment,
  getAdjustment,
  listAdjustments,
  submitAdjustment,
  updateDraftAdjustment,
} from '@/server/services/adjustment.service';
import { HTTPError } from '@/lib/auth/session';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 审批 + 调整,需级联清理。
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
 * 合法编制 payload:1 根(非叶)+ 2 叶(A/B),1 年度 2026。
 * A=600、B=400,合计 1000。
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
      // §enhance3:金额 = 数量 × 单价。A 6×100=600;B 4×100=400。
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

async function expectHTTP(fn: () => Promise<unknown>, status: number): Promise<HTTPError> {
  try {
    await fn();
    throw new Error('应抛 HTTPError 但未抛');
  } catch (e) {
    const err = e as HTTPError;
    expect(err.status).toBe(status);
    return err;
  }
}

describe('adjustment.service (integration, real PG) — 双维度调整', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-adj', role: UserRole.BUDGET_ADMIN },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `ADJ-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `adj ${suffix}` }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validBudgetPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, leafA, leafB };
  }

  it('createAdjustment: 双维度平衡(A 总-100/年-100,B 总+100/年+100) → DRAFT', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('OK');

    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        totalReason: '调剂',
        annualReason: '年度调剂',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );

    expect(adj.status).toBe(ApprovalStatus.DRAFT);
    expect(adj.year).toBe(2026);
    const lines = await prisma.budgetAdjustmentLine.findMany({ where: { adjustmentId: adj.id } });
    expect(lines).toHaveLength(2);
    expect(fromStored(lines[0].totalAdjustment).toFixed(2)).toBe('-100.00');
    expect(fromStored(lines[0].annualAdjustment).toFixed(2)).toBe('-100.00');
  });

  it('草稿允许不平衡:createAdjustment 总维度不平衡 → DRAFT(成功)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('IMBTOT');

    // 草稿是中间态,不校验平衡,允许保存。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '50.00', annualAdjustment: '100.00' }, // 总维度 -100+50≠0
        ],
      },
      adminUser(),
    );
    expect(adj.status).toBe(ApprovalStatus.DRAFT);

    // 提交时才校验平衡 → 422。
    await expectHTTP(() => submitAdjustment(adj.id, adminUser()), 422);
  });

  it('草稿允许不平衡:createAdjustment 年度维度不平衡 → DRAFT,提交时 422', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('IMBANN');

    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '50.00' }, // 年度 -100+50≠0
        ],
      },
      adminUser(),
    );
    expect(adj.status).toBe(ApprovalStatus.DRAFT);

    await expectHTTP(() => submitAdjustment(adj.id, adminUser()), 422);
  });

  it('createAdjustment: 非叶科目 → 422', async () => {
    const { project, leafA } = await seedApprovedProject('NONLEAF');
    const root = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: 'ROOT' },
    });

    await expectHTTP(
      () =>
        createAdjustment(
          project.id,
          {
            year: 2026,
            lines: [
              { subjectId: root!.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
              { subjectId: leafA.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
            ],
          },
          adminUser(),
        ),
      422,
    );
  });

  it('createAdjustment: 缺少 year → 422', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('NOYEAR');

    await expectHTTP(
      () =>
        createAdjustment(
          project.id,
          {
            year: undefined as unknown as number,
            lines: [
              { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
              { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
            ],
          },
          adminUser(),
        ),
      422,
    );
  });

  it('createAdjustment: 归档项目 → 409', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('ARCHIVED');
    await prisma.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } });

    await expectHTTP(
      () =>
        createAdjustment(
          project.id,
          {
            year: 2026,
            lines: [
              { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
              { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
            ],
          },
          adminUser(),
        ),
      409,
    );
  });

  it('listAdjustments: 返回项目调整单(含明细)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('LIST');
    await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-50.00', annualAdjustment: '-50.00' },
          { subjectId: leafB.id, totalAdjustment: '50.00', annualAdjustment: '50.00' },
        ],
      },
      adminUser(),
    );

    const list = await listAdjustments(project.id, adminUser());
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].lines.length).toBeGreaterThanOrEqual(2);
  });

  it('submitAdjustment: 年度调减 ≤ 可调额度 → PENDING,写锁', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('SUBMIT');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' }, // A 600 可调
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );

    const submitted = await submitAdjustment(adj.id, adminUser());
    expect(submitted.status).toBe(ApprovalStatus.PENDING);

    const locks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id, releasedAt: null },
    });
    expect(locks).toHaveLength(1); // 仅 A 的年度调减写锁
    expect(locks[0].subjectId).toBe(leafA.id);
    expect(fromStored(locks[0].amount).toFixed(2)).toBe('100.00');
  });

  it('submitAdjustment: 年度调减超额(A 可调 600,调减 700) → 422,状态仍 DRAFT', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('SUBOVER');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-700.00', annualAdjustment: '-700.00' },
          { subjectId: leafB.id, totalAdjustment: '700.00', annualAdjustment: '700.00' },
        ],
      },
      adminUser(),
    );

    await expectHTTP(() => submitAdjustment(adj.id, adminUser()), 422);
    const after = await getAdjustment(adj.id, adminUser());
    expect(after.status).toBe(ApprovalStatus.DRAFT);
  });

  it('submitAdjustment: 已有待审批锁叠加超额 → 422', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('LOCKSTACK');
    // 第一单:A 调减 500(可调 600),提交成功写锁 500。
    const adj1 = await createAdjustment(
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
    await submitAdjustment(adj1.id, adminUser());

    // 第二单:A 再调减 200(500+200 > 600) → 422。
    const adj2 = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-200.00', annualAdjustment: '-200.00' },
          { subjectId: leafB.id, totalAdjustment: '200.00', annualAdjustment: '200.00' },
        ],
      },
      adminUser(),
    );
    await expectHTTP(() => submitAdjustment(adj2.id, adminUser()), 422);
  });

  it('updateDraftAdjustment: DRAFT 编辑(改金额)成功', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('EDIT');
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

    const updated = await updateDraftAdjustment(
      adj.id,
      {
        year: 2026,
        totalReason: '改了',
        annualReason: '年度改了',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-200.00', annualAdjustment: '-200.00' },
          { subjectId: leafB.id, totalAdjustment: '200.00', annualAdjustment: '200.00' },
        ],
      },
      adminUser(),
    );
    expect(updated.totalReason).toBe('改了');
    expect(updated.annualReason).toBe('年度改了');

    const lines = await prisma.budgetAdjustmentLine.findMany({ where: { adjustmentId: adj.id } });
    expect(fromStored(lines[0].totalAdjustment).toFixed(2)).toBe('-200.00');
  });

  it('updateDraftAdjustment: 草稿允许不平衡(更新成功)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('EDITIMB');
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

    // 草稿编辑允许不平衡,更新成功(平衡校验推迟到提交)。
    const updated = await updateDraftAdjustment(
      adj.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '99.00', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    expect(updated.status).toBe(ApprovalStatus.DRAFT);
    // 提交时才校验平衡 → 422。
    await expectHTTP(() => submitAdjustment(adj.id, adminUser()), 422);
  });

  it('deleteDraftAdjustment: DRAFT 删除成功(明细级联清理)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('DEL');
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

    await deleteDraftAdjustment(adj.id, adminUser());
    await expectHTTP(() => getAdjustment(adj.id, adminUser()), 404);
    const lines = await prisma.budgetAdjustmentLine.findMany({ where: { adjustmentId: adj.id } });
    expect(lines).toHaveLength(0);
  });

  it('createAdjustment: 双维度各自独立(A 总调减 B 总调增,但年度都为0)平衡 → DRAFT', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('TOTONLY');
    // 仅调总预算维度,年度维度全 0(两维度都平衡)。
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
    expect(adj.status).toBe(ApprovalStatus.DRAFT);
  });
});
