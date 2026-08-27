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
  approveAdjustment,
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
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-adj', role: UserRole.ADMIN },
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
    const project = await createProject(
      { code, name: `adj ${suffix}` },
      { id: adminId, role: UserRole.ADMIN },
    );
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

  // ---------------- 追加下达(ALLOCATE) ----------------

  /**
   * ALLOCATE 专用种子:「总预算固定、年度分批做满」——年度只分配 40%:
   * projectTotal=1000;2026 年度=400(A 240 / B 160);科目总预算 A=600、B=400。
   * 剩余可分配:A 360、B 240;项目未分配池 = 1000 − 400 = 600。
   */
  function partialAllocPayload(): InitialBudgetPayload {
    return {
      projectTotal: '1000.00',
      annualBudgets: [{ year: 2026, amount: '400.00' }],
      subjects: [
        { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
        { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
        { code: 'B', name: '叶B', parentCode: 'ROOT', isLeaf: true },
      ],
      subjectBudgets: [
        {
          year: 2026,
          subjectCode: 'A',
          amount: '240.00',
          unit: '次',
          quantity: '2.40',
          unitPrice: '100.00',
        },
        {
          year: 2026,
          subjectCode: 'B',
          amount: '160.00',
          unit: '次',
          quantity: '1.60',
          unitPrice: '100.00',
        },
      ],
      subjectTotalBudgets: [
        { subjectCode: 'A', amount: '600.00' },
        { subjectCode: 'B', amount: '400.00' },
      ],
    };
  }

  /** helper:建项目 + partialAlloc 编制生效(分批场景)。 */
  async function seedPartialProject(suffix: string) {
    const code = `ALLOC-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: `alloc ${suffix}` },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    const { appId } = await createDraft(project.id, partialAllocPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());
    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    return {
      project,
      leafA: subjects.find((s) => s.code === 'A')!,
      leafB: subjects.find((s) => s.code === 'B')!,
    };
  }

  it('ALLOCATE: 新年度提交审批生效 → 自动建 AnnualBudget/SubjectBudget;池内分配不动 ProjectBudget', async () => {
    const { project, leafA, leafB } = await seedPartialProject('NEWYEAR');

    const adj = await createAdjustment(
      project.id,
      {
        year: 2027, // 编制未声明的新年度
        kind: 'ALLOCATE',
        annualReason: '把科目既有总预算分批落地到2027年',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '200.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    expect(adj.kind).toBe('ALLOCATE');
    expect(adj.expandTotals).toBe(false);
    const submitted = await submitAdjustment(adj.id, adminUser());
    expect(submitted.status).toBe(ApprovalStatus.PENDING);
    const approved = await approveAdjustment(adj.id, adminUser());
    expect(approved.status).toBe(ApprovalStatus.APPROVED);

    // 该年未建账 → AnnualBudget(2027) 自动创建:initial=300, adjustment=0, current=300
    // (维持 current = initial + adjustment 恒等式,追加额不重复计入 initial)。
    const ab = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2027 } },
    });
    expect(ab).not.toBeNull();
    expect(ab!.initialAmount.toFixed(2)).toBe('300.00');
    expect(ab!.adjustmentAmount.toFixed(2)).toBe('0.00');
    expect(ab!.currentAmount.toFixed(2)).toBe('300.00');

    // SubjectBudget(2027) 按行创建(initial=0,adjustment=current=分配额)。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2027, subjectId: leafA.id },
      },
    });
    expect(sbA!.currentAmount.toFixed(2)).toBe('200.00');
    expect(sbA!.initialAmount.toFixed(2)).toBe('0.00');
    const sbB = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2027, subjectId: leafB.id },
      },
    });
    expect(sbB!.currentAmount.toFixed(2)).toBe('100.00');

    // 池内分配:项目总盘不变(钱本就在 1000 总预算内,只是落地到年份)。
    const pb = await prisma.projectBudget.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(pb.currentAmount.toFixed(2)).toBe('1000.00');
    expect(pb.initialAmount.toFixed(2)).toBe('1000.00');

    // SubjectTotalBudget 不受追加影响。
    const stbA = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    expect(stbA!.currentAmount.toFixed(2)).toBe('600.00');
  });

  it('ALLOCATE + expandTotals(新经费入账): 跳过容量护栏,STB/ProjectBudget 同步调增且 initial 不动', async () => {
    const { project, leafA } = await seedPartialProject('EXPAND');
    // A 剩余 360,申请 400(超剩余)→ expandTotals 放行,总预算随之增长。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2028,
        kind: 'ALLOCATE',
        expandTotals: true,
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '400.00' }],
      },
      adminUser(),
    );
    expect(adj.expandTotals).toBe(true);
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    const sb = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2028, subjectId: leafA.id },
      },
    });
    expect(sb!.currentAmount.toFixed(2)).toBe('400.00');
    const stbA = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    expect(stbA!.currentAmount.toFixed(2)).toBe('1000.00'); // 600 + 400
    expect(stbA!.initialAmount.toFixed(2)).toBe('600.00'); // initial 不动
    const pb = await prisma.projectBudget.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(pb.currentAmount.toFixed(2)).toBe('1400.00'); // 1000 + 400
    expect(pb.initialAmount.toFixed(2)).toBe('1000.00');
    const ab = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2028 } },
    });
    expect(ab!.currentAmount.toFixed(2)).toBe('400.00');
    expect(ab!.adjustmentAmount.toFixed(2)).toBe('0.00');
    expect(ab!.initialAmount.toFixed(2)).toBe('400.00');
  });

  it('ALLOCATE: 已有年份累加到 AnnualBudget 与既有 SubjectBudget 上', async () => {
    const { project, leafA } = await seedPartialProject('SAMEYEAR');
    // 2026 已有 A=240;追加下达同一年 +60 → 300,AnnualBudget current 400→460。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '60.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    const sb = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    expect(sb!.currentAmount.toFixed(2)).toBe('300.00'); // 240 + 60
    const ab = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
    });
    expect(ab!.currentAmount.toFixed(2)).toBe('460.00'); // 400 + 60
    expect(ab!.initialAmount.toFixed(2)).toBe('400.00'); // initial 不动
    expect(ab!.adjustmentAmount.toFixed(2)).toBe('60.00');
    const pb = await prisma.projectBudget.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(pb.currentAmount.toFixed(2)).toBe('1000.00'); // 池内分配,总盘不变
  });

  it('ALLOCATE: 新增科目零额行 → submit 422(不接受零额建档)', async () => {
    const { project } = await seedPartialProject('ZERONEW');
    const root = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, isLeaf: false },
    });
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          {
            subjectId: null,
            newSubjectName: '零额新科目',
            newSubjectParentId: root!.id,
            totalAdjustment: '0',
            annualAdjustment: '0.00',
          },
        ],
      },
      adminUser(),
    );
    const err = await expectHTTP(() => submitAdjustment(adj.id, adminUser()), 422);
    expect(err.message).toContain('零额建档');
  });

  it('ALLOCATE: 超出剩余可分配额 → submit 422(容量护栏)', async () => {
    const { project, leafA } = await seedPartialProject('CAP');
    // A 剩余 360,申请 400 → 拒绝。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2028,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '400.00' }],
      },
      adminUser(),
    );
    const err = await expectHTTP(() => submitAdjustment(adj.id, adminUser()), 422);
    expect(err.message).toContain('剩余可分配');
  });

  it('ALLOCATE: 负数行/非零 total 行/全零单 均 422', async () => {
    const { project, leafA, leafB } = await seedPartialProject('SHAPE');

    const negAdj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '50.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '-10.00' },
        ],
      },
      adminUser(),
    );
    expect(
      (await expectHTTP(() => submitAdjustment(negAdj.id, adminUser()), 422)).message,
    ).toContain('不能为负');

    const totalAdj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '30.00', annualAdjustment: '50.00' }],
      },
      adminUser(),
    );
    expect(
      (await expectHTTP(() => submitAdjustment(totalAdj.id, adminUser()), 422)).message,
    ).toContain('须为 0');

    const zeroAdj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '0.00' }],
      },
      adminUser(),
    );
    expect(
      (await expectHTTP(() => submitAdjustment(zeroAdj.id, adminUser()), 422)).message,
    ).toContain('至少需要一行正数');
  });

  it('ALLOCATE: isNew 新增科目行 → 审批建档并以首笔分配额立账', async () => {
    const { project } = await seedPartialProject('NEWSUBJ');
    const root = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, isLeaf: false },
    });

    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          {
            subjectId: null,
            newSubjectName: '新设劳务费',
            newSubjectParentId: root!.id,
            totalAdjustment: '0',
            annualAdjustment: '80.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    const created = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, name: '新设劳务费' },
    });
    expect(created).not.toBeNull();
    expect(created!.isLeaf).toBe(true);
    const sb = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2027, subjectId: created!.id },
      },
    });
    expect(sb!.currentAmount.toFixed(2)).toBe('80.00');
    const stb = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: created!.id } },
    });
    expect(stb!.currentAmount.toFixed(2)).toBe('80.00');
  });
});
