import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApprovalStatus, BusinessStatus, Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { exportAdjustmentDocx } from '@/server/services/adjustmentExport.service';
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
  rejectAdjustment,
  createAdjustment,
  deleteDraftAdjustment,
  getAdjustment,
  getAdjustmentBalance,
  getAdjustmentDetail,
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
   * 余额锚定口径:剩余额度 = 1000(无执行占用);A 科目天花板剩余 600、B 400。
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

  it('ALLOCATE: 初始预算未审批生效 → approve 422(防后续编制审批重置追加额度)', async () => {
    // 只建项目 + 编制草稿(不提交审批):科目树存在但状态 DRAFT。
    const project = await createProject(
      { code: `ALLOC-NOINIT-${uuidv7().slice(0, 8)}`, name: 'alloc noinit' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    await createDraft(project.id, partialAllocPayload(), adminUser());
    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const leafA = subjects.find((s) => s.code === 'A')!;

    // 纯 API 路径(前端按钮门控可被绕过):创建/提交放行,审批必须拦截。
    // expandTotals 跳过容量护栏(草稿期 STB current 全 0,池内模式会先被容量拦下,
    // 到不了审批的前提校验)。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        expandTotals: true,
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '50.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    const err = await expectHTTP(() => approveAdjustment(adj.id, adminUser()), 422);
    expect(err.message).toContain('初始预算编制尚未审批生效');

    // 追加未落任何金额:2027 年不应存在 SubjectBudget 行。
    const sbCount = await prisma.subjectBudget.count({
      where: { projectId: project.id, year: 2027 },
    });
    expect(sbCount).toBe(0);
  });

  // ---------------- §issue12 汇总漂移防线 ----------------

  it('导出兜底:project_budgets 与科目层漂移 → 导出 422 拒绝生成文书', async () => {
    const { project, leafA } = await seedApprovedProject('DRIFT');
    // 任一调整单(草稿即可,兜底与状态无关)。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [{ subjectId: leafA.id, totalAdjustment: '0.00', annualAdjustment: '0.00' }],
      },
      adminUser(),
    );

    // 健全状态可正常导出。
    const buf = await exportAdjustmentDocx(adj.id, 'annual', adminUser());
    expect(buf.length).toBeGreaterThan(0);

    // 人为污染 project_budgets.current(破坏恒等式,模拟历史脏数据)→ 拒绝导出。
    await prisma.projectBudget.update({
      where: { projectId: project.id },
      data: { currentAmount: '500000.00' },
    });
    const err = await expectHTTP(() => exportAdjustmentDocx(adj.id, 'annual', adminUser()), 422);
    expect(err.message).toContain('汇总数据漂移');
    expect(err.message).toContain('initial(');

    // 年度维度漂移同样拦截。
    await prisma.projectBudget.update({
      where: { projectId: project.id },
      data: { currentAmount: '1000.00' },
    });
    await prisma.annualBudget.update({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
      data: { currentAmount: '999999.00' },
    });
    const err2 = await expectHTTP(() => exportAdjustmentDocx(adj.id, 'annual', adminUser()), 422);
    expect(err2.message).toContain('年度预算(2026)');

    // 恢复后可再次导出(验证拦截基于实时数据)。
    await prisma.annualBudget.update({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
      data: { currentAmount: '1000.00' },
    });
    const buf2 = await exportAdjustmentDocx(adj.id, 'annual', adminUser());
    expect(buf2.length).toBeGreaterThan(0);

    // 合法未分配池不受拦截:恒等式自洽(1500=1500+0)且 current > Σ科目总预算
    // (编制仅要求 Σ科目 ≤ 总盘,差额是合法池,不得误判为漂移)。
    await prisma.projectBudget.update({
      where: { projectId: project.id },
      data: { initialAmount: '1500.00', currentAmount: '1500.00' },
    });
    const buf3 = await exportAdjustmentDocx(adj.id, 'annual', adminUser());
    expect(buf3.length).toBeGreaterThan(0);
  });

  it('恒等式防线:追加审批后各层满足 current = initial + adjustment', async () => {
    const { project, leafA } = await seedPartialProject('IDENT');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        expandTotals: true,
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '120.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    const pb = await prisma.projectBudget.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(
      pb.currentAmount.minus(pb.initialAmount).minus(pb.adjustmentAmount).abs().toNumber(),
    ).toBeLessThan(0.01);
    const ab = await prisma.annualBudget.findUniqueOrThrow({
      where: { projectId_year: { projectId: project.id, year: 2027 } },
    });
    expect(
      ab.currentAmount.minus(ab.initialAmount).minus(ab.adjustmentAmount).abs().toNumber(),
    ).toBeLessThan(0.01);
    const sb = await prisma.subjectBudget.findUniqueOrThrow({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2027, subjectId: leafA.id },
      },
    });
    expect(
      sb.currentAmount.minus(sb.initialAmount).minus(sb.adjustmentAmount).abs().toNumber(),
    ).toBeLessThan(0.01);
    const stb = await prisma.subjectTotalBudget.findUniqueOrThrow({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    expect(
      stb.currentAmount.minus(stb.initialAmount).minus(stb.adjustmentAmount).abs().toNumber(),
    ).toBeLessThan(0.01);
  });

  it('ALLOCATE: 并发双重审批 → 恰好一个成功另一个 409,金额不重复应用', async () => {
    const { project, leafA } = await seedPartialProject('RACE');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '100.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    // 两个审批同时发起(都在事务外读到 PENDING);行锁 + 锁内复核保证只有一个生效。
    const results = await Promise.allSettled([
      approveAdjustment(adj.id, adminUser()),
      approveAdjustment(adj.id, adminUser()),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected409 = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof HTTPError &&
        (r.reason as HTTPError).status === 409,
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected409.length).toBe(1);

    // 金额恰好应用一次(未被第二个事务重复累加)。
    const sb = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2027, subjectId: leafA.id },
      },
    });
    expect(sb!.currentAmount.toFixed(2)).toBe('100.00');
  });

  it('ALLOCATE: 余额锚定——计划与加法池脱钩(可超历年计划合计),超科目总预算剩余 422', async () => {
    const { project, leafA, leafB } = await seedPartialProject('CAP');
    // 编制:total 1000;2026 年度 400(A 240);A 的 STB=600。
    // 旧模型:A 历年已分配 240,剩余可分配 360,下达 500 必拒;
    // 新模型:计划与 Σ年度脱钩——A 无执行占用,2028 一次性下达 500(< STB 600)合法。
    const ok = await createAdjustment(
      project.id,
      {
        year: 2028,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '500.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(ok.id, adminUser());
    await approveAdjustment(ok.id, adminUser());
    const sb = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2028, subjectId: leafA.id },
      },
    });
    expect(sb!.currentAmount.toFixed(2)).toBe('500.00');

    // A 的 STB=600、累计占用 0:2029 再下达 700 → 本年剩余计划 700 > 科目总预算剩余 600 → 422。
    // (项目层 700 ≤ 剩余额度 1000 放行,由科目层拦截。)
    const overSubject = await createAdjustment(
      project.id,
      {
        year: 2029,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '700.00' }],
      },
      adminUser(),
    );
    const err = await submitAdjustment(overSubject.id, adminUser()).catch((e) => e);
    expect(err).toMatchObject({ status: 422 });
    expect(err.message).toContain('超出可下达额度');
    expect(err.message).toContain('科目总预算剩余');

    // 项目层红线:同单 1100 > 项目剩余额度 1000 → 422(先于科目层拦截)。
    const overProject = await createAdjustment(
      project.id,
      {
        year: 2029,
        kind: 'ALLOCATE',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '400.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '700.00' },
        ],
      },
      adminUser(),
    );
    const err2 = await submitAdjustment(overProject.id, adminUser()).catch((e) => e);
    expect(err2).toMatchObject({ status: 422 });
    expect(err2.message).toContain('项目剩余额度');
  });

  it('ALLOCATE: 在途 PENDING 追加单预订额度——第二张同额度单提交 422(在途投影)', async () => {
    const { project, leafA, leafB } = await seedPartialProject('PENDING');
    // 单 A:2027 下达 800(A 450 + B 350,均在各自 STB 内;合计 ≤ 剩余额度 1000)→ PENDING。
    const first = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '450.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '350.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(first.id, adminUser());

    // 单 B:同样 800。若不计在途,headroom = 1000 ≥ 800 会漏过;投影在途 800 后
    // 可新增 = 200 < 800 → 422,报文含「在途追加单已预订」。
    const second = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '450.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '350.00' },
        ],
      },
      adminUser(),
    );
    const err = await submitAdjustment(second.id, adminUser()).catch((e) => e);
    expect(err).toMatchObject({ status: 422 });
    expect(err.message).toContain('在途追加单已预订');

    // 审批第一张后,第三张 150(A)≤ 可新增 200,且 A 本年计划 450+150=600 ≤ STB → 可提交。
    await approveAdjustment(first.id, adminUser());
    const smaller = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '150.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(smaller.id, adminUser());
  });

  it('ALLOCATE: 在途预订只挡同目标年——2027 在途不消耗 2028 可下达额度(§codex P2)', async () => {
    const { project, leafA, leafB } = await seedPartialProject('CROSSYEAR');
    // 2027 在途 800(A 450 + B 350)保持 PENDING。
    const pending2027 = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '450.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '350.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(pending2027.id, adminUser());

    // 2028 下达 600:异年在途不投影 → 剩余额度 1000 全量可用,正常通过提交并审批。
    // (修复前 pendingAllocateTotal 计入异年 800 → 600 > 200 被错挡,且审批 2027 后同单又能过,
    //  结论随审批顺序漂移。)
    const adj2028 = await createAdjustment(
      project.id,
      {
        year: 2028,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '600.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(adj2028.id, adminUser());
    await approveAdjustment(adj2028.id, adminUser());
    const ab2028 = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2028 } },
    });
    expect(ab2028!.currentAmount.toFixed(2)).toBe('600.00');
  });

  it('ALLOCATE: 遗留结转副本归一化——成对并存只计一腿,虚增占用不再错挡下达(§codex P1)', async () => {
    const { project, leafA } = await seedPartialProject('LEGACY');
    // 旧跨年结转产物:源记录(2026,A,300)+ 副本(2027,同额,remark「[结转自2026]」),
    // carryover_out/carryover_in 留痕以 reason 互相引用(与旧 yearCarryover.service 写法一致)。
    const srcId = uuidv7();
    const copyId = uuidv7();
    await prisma.businessRecord.createMany({
      data: [
        {
          id: srcId,
          projectId: project.id,
          budgetYear: 2026,
          subjectId: leafA.id,
          amount: '300.00',
          businessDate: new Date('2026-03-01T00:00:00Z'),
          handler: '旧',
          summary: '结转源',
          status: BusinessStatus.FINANCE_APPROVAL,
          createdById: adminId,
        },
        {
          id: copyId,
          projectId: project.id,
          budgetYear: 2027,
          subjectId: leafA.id,
          amount: '300.00',
          businessDate: new Date('2026-03-01T00:00:00Z'),
          handler: '旧',
          summary: '结转源',
          status: BusinessStatus.FINANCE_APPROVAL,
          remark: '[结转自2026]',
          createdById: adminId,
        },
      ],
    });
    await prisma.businessRecordHistory.createMany({
      data: [
        {
          id: uuidv7(),
          businessRecordId: srcId,
          action: 'carryover_out',
          beforeData: Prisma.JsonNull,
          afterData: Prisma.JsonNull,
          operatorId: adminId,
          reason: `结转至 2027 年记录 ${copyId}`,
        },
        {
          id: uuidv7(),
          businessRecordId: copyId,
          action: 'carryover_in',
          beforeData: Prisma.JsonNull,
          afterData: Prisma.JsonNull,
          operatorId: adminId,
          reason: `结转自 2026 年记录 ${srcId}`,
        },
      ],
    });

    // 归一化后占用 = 300(只算源腿):余额面板 300、2027 可下达恰好放行;
    // 若双计(600)则科目天花板剩余 0,科目层直接拒绝。
    const balance = await getAdjustmentBalance(project.id, 2027, adminUser());
    expect(balance.projectOccupied).toBe('300.00');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '300.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    // 源作废后副本接管计数:占用仍 300(副本 300,源已废),不是 0 也不是 600。
    await prisma.businessRecord.update({ where: { id: srcId }, data: { isVoid: true } });
    const balance2 = await getAdjustmentBalance(project.id, 2028, adminUser());
    expect(balance2.projectOccupied).toBe('300.00');
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

  it('ALLOCATE: 新增科目可挂在无预算的叶节点下(父转非叶);有预算叶父 → 422', async () => {
    const { project, leafA } = await seedPartialProject('LEAFPARENT');
    // 构造一个无预算叶节点(无 SubjectBudget / SubjectTotalBudget)。
    const budgetlessLeafId = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: budgetlessLeafId,
        projectId: project.id,
        parentId: null,
        code: `EMPTY-${uuidv7().slice(0, 6)}`,
        name: '无预算叶',
        level: 1,
        isLeaf: true,
      },
    });

    // 有预算的叶父(leafA 已有科目预算)→ 创建即 422。
    await expect(
      createAdjustment(
        project.id,
        {
          year: 2027,
          kind: 'ALLOCATE',
          lines: [
            {
              subjectId: null,
              newSubjectName: '挂预算叶',
              newSubjectParentId: leafA.id,
              totalAdjustment: '0',
              annualAdjustment: '10.00',
            },
          ],
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('已有预算'),
    });

    // 无预算叶父 → 审批建档成功,且父节点转为非叶。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          {
            subjectId: null,
            newSubjectName: '挂无预算叶',
            newSubjectParentId: budgetlessLeafId,
            totalAdjustment: '0',
            annualAdjustment: '10.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    const created = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, name: '挂无预算叶' },
    });
    expect(created).not.toBeNull();
    expect(created!.parentId).toBe(budgetlessLeafId);
    const parent = await prisma.budgetSubject.findUnique({ where: { id: budgetlessLeafId } });
    expect(parent!.isLeaf).toBe(false);
  });

  it('ALLOCATE: 新增科目可不带父节点直接建为一级科目(level=1)', async () => {
    const { project } = await seedPartialProject('TOPSUBJ');
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          {
            subjectId: null,
            newSubjectName: '新设一级科目',
            newSubjectParentId: null, // 无父节点 = 一级科目
            totalAdjustment: '0',
            annualAdjustment: '50.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    const created = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, name: '新设一级科目' },
    });
    expect(created).not.toBeNull();
    expect(created!.parentId).toBeNull();
    expect(created!.level).toBe(1);
    expect(created!.isLeaf).toBe(true);
    const sb = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2027, subjectId: created!.id },
      },
    });
    expect(sb!.currentAmount.toFixed(2)).toBe('50.00');
  });

  // ---------------- §issue16 总预算审批表导出全科目 ----------------

  it('总维度导出:覆盖全部叶科目(含未调整),行序按科目表顺序且重复导出稳定', async () => {
    const code = `EXP-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: 'exp all' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    // 3 叶:A/B/C(预算 600/400/200,年度 1000 全分配)。
    const payload: InitialBudgetPayload = {
      projectTotal: '1200.00',
      annualBudgets: [{ year: 2026, amount: '1200.00' }],
      subjects: [
        { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
        { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
        { code: 'B', name: '叶B', parentCode: 'ROOT', isLeaf: true },
        { code: 'C', name: '叶C', parentCode: 'ROOT', isLeaf: true },
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
        {
          year: 2026,
          subjectCode: 'C',
          amount: '200.00',
          unit: '次',
          quantity: '2.00',
          unitPrice: '100.00',
        },
      ],
      subjectTotalBudgets: [
        { subjectCode: 'A', amount: '600.00' },
        { subjectCode: 'B', amount: '400.00' },
        { subjectCode: 'C', amount: '200.00' },
      ],
    };
    const { appId } = await createDraft(project.id, payload, adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());
    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    // 调剂:A +50 / B -50(总维度平衡,年度 0);C 不动。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '50.00', annualAdjustment: '0.00' },
          { subjectId: leafB.id, totalAdjustment: '-50.00', annualAdjustment: '0.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    // 行序确定性:getAdjustment 的 lines 按 id(uuidv7)升序 = 创建顺序。
    const detail = await getAdjustment(adj.id, adminUser());
    expect(detail.lines.map((l) => l.subjectId)).toEqual([leafA.id, leafB.id]);

    // 导出总维度 docx,解包 word/document.xml 断言内容与顺序。
    const JSZip = (await import('jszip')).default;
    const unzip = async (buf: Buffer) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file('word/document.xml')!.async('text');
    };
    const xml1 = await unzip(await exportAdjustmentDocx(adj.id, 'total', adminUser()));
    // 全科目在列:叶C(未调整)也出现。
    expect(xml1).toContain('叶A');
    expect(xml1).toContain('叶B');
    expect(xml1).toContain('叶C');
    // 行序 = 科目表顺序(sortOrder):A→B→C。
    expect(xml1.indexOf('叶A')).toBeLessThan(xml1.indexOf('叶B'));
    expect(xml1.indexOf('叶B')).toBeLessThan(xml1.indexOf('叶C'));
    // 已生效单基线重建:叶C 未调整 → 原预算 200 元 = 0.02 万(与调整后一致),
    // 不因重建误扣(若误扣会变成负数/0)。
    const cIdx = xml1.indexOf('叶C');
    const cSection = xml1.slice(cIdx, cIdx + 3000);
    expect(cSection).toContain('0.02');
    // 重复导出结果稳定(document.xml 内容一致)。
    const xml2 = await unzip(await exportAdjustmentDocx(adj.id, 'total', adminUser()));
    expect(xml2).toBe(xml1);
  });

  it('§codex P1:审批后新设科目只成行一次,且原预算为 0(建档回写 subjectId)', async () => {
    const { project } = await seedPartialProject('DUPSUBJ');
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
            newSubjectName: '重复校验科目',
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

    // 审批回写:明细行 subjectId 指向新科目(导出按科目口径渲染的前提)。
    const created = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, name: '重复校验科目' },
    });
    const line = await prisma.budgetAdjustmentLine.findFirstOrThrow({
      where: { adjustmentId: adj.id },
    });
    expect(line.subjectId).toBe(created!.id);

    // 总维度导出:新设科目只出现一次(修复前:目录循环 + isNew 分支各一次)。
    // 池内分配不调总盘,行内容为 0/0/0(与既有语义一致)。
    const JSZip = (await import('jszip')).default;
    const unzip = async (buf: Buffer) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file('word/document.xml')!.async('text');
    };
    const xml = await unzip(await exportAdjustmentDocx(adj.id, 'total', adminUser()));
    const occurrences = xml.split('重复校验科目').length - 1;
    expect(occurrences).toBe(1);
  });

  it('§codex P1:目录按审批时点取景——他单后建科目不出现在本单历史文书', async () => {
    const { project } = await seedPartialProject('CATALOG');
    const root = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, isLeaf: false },
    });

    // 第一单:新增科目甲(80),审批生效。
    const first = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          {
            subjectId: null,
            newSubjectName: '时点科目甲',
            newSubjectParentId: root!.id,
            totalAdjustment: '0',
            annualAdjustment: '80.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(first.id, adminUser());
    await approveAdjustment(first.id, adminUser());

    // 第二单:再新增科目乙(20),审批生效。
    const second = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          {
            subjectId: null,
            newSubjectName: '时点科目乙',
            newSubjectParentId: root!.id,
            totalAdjustment: '0',
            annualAdjustment: '20.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(second.id, adminUser());
    await approveAdjustment(second.id, adminUser());

    const JSZip = (await import('jszip')).default;
    const unzip = async (buf: Buffer) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file('word/document.xml')!.async('text');
    };
    // 重新导出第一单:含甲(本单新设,原值 0),不含乙(他单后建)。
    const xmlFirst = await unzip(await exportAdjustmentDocx(first.id, 'total', adminUser()));
    expect(xmlFirst.split('时点科目甲').length - 1).toBe(1);
    expect(xmlFirst).not.toContain('时点科目乙');
    // 乙出现在第二单自己的文书里。
    const xmlSecond = await unzip(await exportAdjustmentDocx(second.id, 'total', adminUser()));
    expect(xmlSecond.split('时点科目乙').length - 1).toBe(1);
  });

  it('§codex P1:待审/草稿单导出包含新设科目行(未建档不丢行)', async () => {
    const { project } = await seedPartialProject('PENDINGNEW');
    const root = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, isLeaf: false },
    });

    // 待审单(提交但不审批):含新设科目行。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [
          {
            subjectId: null,
            newSubjectName: '待审新设科目',
            newSubjectParentId: root!.id,
            totalAdjustment: '0',
            annualAdjustment: '80.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const JSZip = (await import('jszip')).default;
    const unzip = async (buf: Buffer) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file('word/document.xml')!.async('text');
    };
    // 年度维度:新设科目在列,调整额 80 元 = 0.008 万(精确换算,不截断)。
    const xmlAnnual = await unzip(await exportAdjustmentDocx(adj.id, 'annual', adminUser()));
    expect(xmlAnnual).toContain('待审新设科目');
    expect(xmlAnnual).toContain('0.008');
    // 总维度:同样在列(池内分配 0/0/0)。
    const xmlTotal = await unzip(await exportAdjustmentDocx(adj.id, 'total', adminUser()));
    expect(xmlTotal).toContain('待审新设科目');
  });

  it('§codex P1:历史单据(subjectId 未回写)导出仍含新设科目(解析不受时钟截断)', async () => {
    const { project } = await seedPartialProject('LEGACYNEW');
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
            newSubjectName: '历史新设科目',
            newSubjectParentId: root!.id,
            totalAdjustment: '0',
            annualAdjustment: '50.00',
          },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());

    // 模拟历史数据:清掉审批回写的 subjectId(旧行为不回写)。
    await prisma.budgetAdjustmentLine.updateMany({
      where: { adjustmentId: adj.id },
      data: { subjectId: null },
    });

    const JSZip = (await import('jszip')).default;
    const unzip = async (buf: Buffer) => {
      const zip = await JSZip.loadAsync(buf);
      return zip.file('word/document.xml')!.async('text');
    };
    const xml = await unzip(await exportAdjustmentDocx(adj.id, 'total', adminUser()));
    // 解析回 born 科目,恰好成行一次。
    expect(xml.split('历史新设科目').length - 1).toBe(1);
  });
});

describe('getAdjustmentDetail (§issue15) — 审批详情基线重建', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-adjdetail', role: UserRole.ADMIN },
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

  it('待审单:原预算 = 提交时刻快照,调整后 = 原值+调整额,合计平衡', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('det1');

    // 单一:总维度 ±100,年度维度不动(Σ=0 合法)。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        totalReason: '总盘调剂',
        annualReason: '年度不动',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const detail = await getAdjustmentDetail(adj.id, adminUser());
    expect(detail.status).toBe(ApprovalStatus.PENDING);
    expect(detail.lines).toHaveLength(2);

    const rowA = detail.lines.find((l) => l.subjectId === leafA.id)!;
    const rowB = detail.lines.find((l) => l.subjectId === leafB.id)!;
    // 提交时刻快照:live 未被本单污染(待审不生效)。
    expect(rowA.originTotal).toBe('600.00');
    expect(rowB.originTotal).toBe('400.00');
    expect(rowA.originAnnual).toBe('600.00');
    expect(rowB.originAnnual).toBe('400.00');
    // 科目名解析(服务端给出,免前端查树)。
    expect(rowA.subjectName).toBe('叶A');
    expect(rowB.subjectName).toBe('叶B');
    // 调整后 = 原值 + 调整额。
    expect(rowA.afterTotal).toBe('500.00');
    expect(rowB.afterTotal).toBe('500.00');
    expect(rowA.afterAnnual).toBe('600.00');
    // 合计:调剂零和。
    expect(detail.sums.adjustTotal).toBe('0.00');
    expect(detail.sums.adjustAnnual).toBe('0.00');
    expect(detail.sums.afterTotal).toBe('1000.00');
    expect(detail.sums.afterAnnual).toBe('1000.00');
  });

  it('已生效单之后的新待审单:快照含前单生效结果;提交后他单生效不影响其基线', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('det2');

    // 第一单:审批生效,A−100/B+100 → live A500/B500。
    const first = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(first.id, adminUser());
    await approveAdjustment(first.id, adminUser());

    // 第二单:提交(PENDING)。
    const second = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-50.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '50.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(second.id, adminUser());
    const detailBefore = await getAdjustmentDetail(second.id, adminUser());
    expect(detailBefore.lines.find((l) => l.subjectId === leafA.id)!.originTotal).toBe('500.00');

    // 第三单(模拟"提交后他单先生效"):审批生效第二单……用第三单制造提交后的并发生效。
    const third = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-20.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '20.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(third.id, adminUser());
    await approveAdjustment(third.id, adminUser());

    // 第二单仍是 PENDING:基线 = 提交时刻(500),不被第三单生效污染。
    const detail = await getAdjustmentDetail(second.id, adminUser());
    const rowA = detail.lines.find((l) => l.subjectId === leafA.id)!;
    expect(rowA.originTotal).toBe('500.00');
    expect(rowA.afterTotal).toBe('450.00');
    // 导出场景同口径:第二单审批生效后,其"原预算" = 审批前一刻的 live
    // (第三单已生效,故为 500−20=480,而非提交时刻的 500)。
    await approveAdjustment(second.id, adminUser());
    const detailApproved = await getAdjustmentDetail(second.id, adminUser());
    expect(detailApproved.lines.find((l) => l.subjectId === leafA.id)!.originTotal).toBe('480.00');
  });

  it('新增科目行:父节点名服务端解析,原值为 0', async () => {
    const { project, leafA } = await seedApprovedProject('det3');
    const root = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, isLeaf: false },
    });

    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          {
            subjectId: null,
            newSubjectName: '测试新科目',
            newSubjectParentId: root!.id,
            totalAdjustment: '0',
            annualAdjustment: '30.00',
          },
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '-30.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const detail = await getAdjustmentDetail(adj.id, adminUser());
    const newRow = detail.lines.find((l) => l.isNew)!;
    expect(newRow.newSubjectName).toBe('测试新科目');
    expect(newRow.newSubjectParentName).toBe('根');
    expect(newRow.originTotal).toBe('0.00');
    expect(newRow.originAnnual).toBe('0.00');
    expect(newRow.afterAnnual).toBe('30.00');
  });

  it('§总维度调减护栏:调减超过科目总预算 → submit 422;恰好归零允许', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('floor1');

    // A 总预算 600,调减 700 → 超调。
    const over = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-700.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '700.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await expectHTTP(() => submitAdjustment(over.id, adminUser()), 422);

    // 恰好归零(600)允许;审批生效后 A 总预算 = 0。
    const exact = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-600.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '600.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(exact.id, adminUser());
    await approveAdjustment(exact.id, adminUser());
    const stb = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    expect(stb!.currentAmount.toFixed(2)).toBe('0.00');
  });

  it('§总维度调减护栏:在途 PENDING 调减计入投影,并发提交被拦', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('floor2');

    // 单1:A -500(600→100)提交在途。
    const first = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-500.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '500.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(first.id, adminUser());

    // 单2:A 再 -200 → 投影 100-200 < 0 → 提交被拦。
    const second = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-200.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '200.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await expectHTTP(() => submitAdjustment(second.id, adminUser()), 422);

    // 单1审批生效(A=100)后,-100 恰好归零可以;再 -200 仍被拦。
    await approveAdjustment(first.id, adminUser());
    const third = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-100.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '100.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(third.id, adminUser());
    await approveAdjustment(third.id, adminUser());
    const stb = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    expect(stb!.currentAmount.toFixed(2)).toBe('0.00');
  });

  it('§总维度调减护栏:两单在途挤压(投影归零边界)按序审批终值归零', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('floor3');

    // 单2 先提交(无在途:600-50=550 ✓);单1 后提交(计入单2 在途 -50:600-50-550=0 边界 ✓)。
    // 两张都在途 → 挤压审批:无论先后顺序,任何一张都不会把 A 推成负数。
    const second = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-50.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '50.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(second.id, adminUser());
    const first = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-550.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '550.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(first.id, adminUser());

    // 先批大调减(A 600→50),再批小调减(50→0)。
    await approveAdjustment(first.id, adminUser());
    await approveAdjustment(second.id, adminUser());
    const stb = await prisma.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId: project.id, subjectId: leafA.id } },
    });
    expect(stb!.currentAmount.toFixed(2)).toBe('0.00');

    // 归零后再想调减 → 被拦。
    const fourth = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-1.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '1.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await expectHTTP(() => submitAdjustment(fourth.id, adminUser()), 422);
  });

  it('§驳回后再提交:REJECTED 可编辑/再提交(锁重建、额度重校验、意见随详情下发)', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('resubmit');

    // A 年度 -550 提交 → 驳回(锁释放,状态 REJECTED,意见落审批日志)。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        totalReason: '总盘调剂',
        annualReason: '年度调剂',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '-550.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '550.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    const firstSubmittedAt = (await getAdjustment(adj.id, adminUser())).submittedAt;
    expect(firstSubmittedAt).not.toBeNull();
    await rejectAdjustment(adj.id, adminUser(), '额度依据不足,退回修改');

    const rejected = await getAdjustment(adj.id, adminUser());
    expect(rejected.status).toBe(ApprovalStatus.REJECTED);
    // 锁已释放。
    const activeLocks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id, releasedAt: null },
    });
    expect(activeLocks).toHaveLength(0);
    // 详情下发最近驳回意见。
    const detail = await getAdjustmentDetail(adj.id, adminUser());
    expect(detail.rejectionOpinion).toBe('额度依据不足,退回修改');

    // 驳回后可编辑(改小额),再提交 → 锁重建、状态回 PENDING。
    await updateDraftAdjustment(
      adj.id,
      {
        year: 2026,
        totalReason: '总盘调剂(修改后)',
        annualReason: '年度调剂(修改后)',
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '-100.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    const resubmitted = await getAdjustment(adj.id, adminUser());
    expect(resubmitted.status).toBe(ApprovalStatus.PENDING);
    // §codex P2:再提交刷新提交时间(详情基线快照参照随之更新)。
    expect(resubmitted.submittedAt!.getTime()).toBeGreaterThan(firstSubmittedAt!.getTime());
    const rebuiltLocks = await prisma.budgetLock.findMany({
      where: { adjustmentId: adj.id, releasedAt: null },
    });
    expect(rebuiltLocks).toHaveLength(1); // A 的年度调减锁

    // §版本绑定:携带过期提交代的审批 → 409(防止批准未审阅的新轮次)。
    await expect(
      approveAdjustment(adj.id, adminUser(), undefined, '2000-01-01T00:00:00.000Z'),
    ).rejects.toMatchObject({ status: 409 });

    // 携带正确提交代 → 通过。
    const fresh = await getAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser(), undefined, fresh.submittedAt!.toISOString());
    // §审批记录:流转历史完整保留(新建→提交→驳回(含意见)→修改→提交→审批)。
    const finalDetail = await getAdjustmentDetail(adj.id, adminUser());
    const actions = finalDetail.history.map((h) => h.action);
    expect(actions).toEqual(['create', 'submit', 'reject', 'update', 'submit', 'approve']);
    const rejectEntry = finalDetail.history.find((h) => h.action === 'reject')!;
    expect(rejectEntry.opinion).toBe('额度依据不足,退回修改');
    expect(rejectEntry.operatorName).toBe('admin-adjdetail');
    const sb = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA.id },
      },
    });
    expect(sb!.currentAmount.toFixed(2)).toBe('500.00');

    // 边界守卫不变:APPROVED 单不可编辑。
    await expect(
      updateDraftAdjustment(
        adj.id,
        {
          year: 2026,
          lines: [
            { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '0' },
            { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '0' },
          ],
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 409 });

    // 再提交护栏仍在:新单超调(A 年度 500,调减 600)→ 422。
    const over = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '0', annualAdjustment: '-600.00' },
          { subjectId: leafB.id, totalAdjustment: '0', annualAdjustment: '600.00' },
        ],
      },
      adminUser(),
    );
    await expectHTTP(() => submitAdjustment(over.id, adminUser()), 422);
  });

  it('§codex P2:同科目多行净额护栏——净调减合法不误杀,净超调仍拦截', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('netfloor');

    // A 拆两行 -700/+200(净 -500 ≤ 600 合法),B +500 平衡 → 提交应放行。
    const ok = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-700.00', annualAdjustment: '0' },
          { subjectId: leafA.id, totalAdjustment: '200.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '500.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(ok.id, adminUser());

    // 净调减超限:A -700/+100(净 -600 > 600? 净 -600 ≤ 600 边界)改 -800/+100 → 净 -700 超调 → 拦。
    const over = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-800.00', annualAdjustment: '0' },
          { subjectId: leafA.id, totalAdjustment: '100.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '700.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await expectHTTP(() => submitAdjustment(over.id, adminUser()), 422);
  });

  it('§总维度调减护栏:同科目净调减的两单并发提交 → 恰好一个成功', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('floorrace');
    // A 600:单1 净 -500 合法;单2 净 -200 只有在看不见单1 PENDING 时才会漏过。
    const first = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-500.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '500.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    const second = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-200.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '200.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );

    const results = await Promise.allSettled([
      submitAdjustment(first.id, adminUser()),
      submitAdjustment(second.id, adminUser()),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason?.status === 422,
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('§codex P2:同一科目多行 → 详情按科目聚合,原预算不重复计入', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('dupdetail');

    // A 拆两行(-30/-30),合计 -60;B +60 平衡。审批生效按科目累加。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        lines: [
          { subjectId: leafA.id, totalAdjustment: '-30.00', annualAdjustment: '0' },
          { subjectId: leafA.id, totalAdjustment: '-30.00', annualAdjustment: '0' },
          { subjectId: leafB.id, totalAdjustment: '60.00', annualAdjustment: '0' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());

    const detail = await getAdjustmentDetail(adj.id, adminUser());
    // 聚合后 A 只有一行。
    const rowsA = detail.lines.filter((l) => l.subjectId === leafA.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].totalAdjustment).toBe('-60.00');
    // 原预算只计一次:600(而非 2×600)。
    expect(rowsA[0].originTotal).toBe('600.00');
    expect(rowsA[0].afterTotal).toBe('540.00');
    // 合计:原预算 Σ = 600+400=1000,不虚增;调整后 Σ = 1000。
    expect(detail.sums.originTotal).toBe('1000.00');
    expect(detail.sums.afterTotal).toBe('1000.00');
    expect(detail.sums.adjustTotal).toBe('0.00');
  });
});
