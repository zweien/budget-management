import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject, updateProject } from '@/server/services/project.service';
import {
  approveAdjustment,
  createAdjustment,
  submitAdjustment,
} from '@/server/services/adjustment.service';
import { balanceStatistics } from '@/server/services/statistics.service';
import { getProjectLedger } from '@/server/services/ledger.service';
import { fromStored, sumAmounts } from '@/lib/decimal';

// §包干制(LUMP_SUM)集成测试:总预算不编科目总预算层,年度预算仍分解到科目。
// 覆盖:项目类型字段与切换锁定、编制(无 STB)、调整(总维度拒绝/项目级池)、
// 结余统计与台账的总口径回退。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetLock.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetAdjustmentLine
    .deleteMany({ where: { adjustment: { projectId } } })
    .catch(() => {});
  await prisma.budgetAdjustment.deleteMany({ where: { projectId } }).catch(() => {});
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

/** 包干制编制 payload:根 + 两叶,单年度 2026(合计 1000 = 总预算)。
 *  特意带上 subjectTotalBudgets——包干制下服务端必须忽略(不落库)。 */
function lumpPayload(): InitialBudgetPayload {
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

describe('lumpSum 预算类型(§包干制, integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({ data: { id: adminId, name: 'admin-lump', role: UserRole.ADMIN } });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function createLumpProject(name: string) {
    const project = await createProject(
      { code: `LUMP-${uuidv7().slice(-12)}`, name, budgetMode: 'LUMP_SUM' },
      adminUser(),
    );
    createdProjectIds.push(project.id);
    return project;
  }

  /** 走完 编制→提交→审批,返回科目 code → id 映射。 */
  async function approveLumpBudget(projectId: string) {
    const { appId } = await createDraft(projectId, lumpPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());
    const subjects = await prisma.budgetSubject.findMany({ where: { projectId } });
    return new Map(subjects.map((s) => [s.code, s.id] as const));
  }

  it('project.budgetMode:创建可指定 LUMP_SUM;非法值 422;缺省 GENERAL', async () => {
    const lump = await createLumpProject('包干建项');
    expect(lump.budgetMode).toBe('LUMP_SUM');

    const general = await createProject(
      { code: `GEN-${uuidv7().slice(-12)}`, name: '一般缺省' },
      adminUser(),
    );
    createdProjectIds.push(general.id);
    expect(general.budgetMode).toBe('GENERAL');

    await expect(
      createProject(
        { code: `BAD-${uuidv7().slice(-12)}`, name: '非法类型', budgetMode: 'FIXED' },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('§切变锁定:空白项目可互转;有编制草稿/业务记录/调整/到账后 422', async () => {
    // 空白项目:GENERAL ↔ LUMP_SUM 双向可切。
    const blank = await createProject(
      { code: `SW-${uuidv7().slice(-12)}`, name: '空白切换' },
      adminUser(),
    );
    createdProjectIds.push(blank.id);
    const toLump = await updateProject(blank.id, { budgetMode: 'LUMP_SUM' }, adminUser());
    expect(toLump.budgetMode).toBe('LUMP_SUM');
    const back = await updateProject(blank.id, { budgetMode: 'GENERAL' }, adminUser());
    expect(back.budgetMode).toBe('GENERAL');

    // 有编制草稿(任意状态含 DRAFT)→ 锁定。
    const withDraft = await createLumpProject('草稿锁定');
    await createDraft(withDraft.id, lumpPayload(), adminUser());
    await expect(
      updateProject(withDraft.id, { budgetMode: 'GENERAL' }, adminUser()),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('预算类型不可切换'),
    });

    // 有业务记录 → 锁定。
    const withRecord = await createLumpProject('记录锁定');
    const subjects = await approveLumpBudget(withRecord.id);
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId: withRecord.id,
        budgetYear: 2026,
        subjectId: subjects.get('A')!,
        amount: '100.00',
        businessDate: new Date('2026-03-01'),
        handler: '测试',
        summary: '锁定测试记录',
        status: BusinessStatus.PAID,
        createdById: adminId,
      },
    });
    await expect(
      updateProject(withRecord.id, { budgetMode: 'GENERAL' }, adminUser()),
    ).rejects.toMatchObject({ status: 422 });

    // 仅改其他字段(budgetMode 未变)不被锁定误拦。
    const renamed = await updateProject(withRecord.id, { name: '改名不受限' }, adminUser());
    expect(renamed.name).toBe('改名不受限');
  });

  it('编制:payload 带科目总预算被忽略(不落 STB);Σ年度>总预算与年度叶合计>年度预算仍拒绝;审批后三层 current 置位且无 STB', async () => {
    const project = await createLumpProject('包干编制');

    // 规则 5(Σ年度 ≤ 总预算)照常。
    const overTotal = lumpPayload();
    overTotal.annualBudgets = [{ year: 2026, amount: '1200.00' }];
    await expect(createDraft(project.id, overTotal, adminUser())).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('不得超过项目初始总预算'),
    });

    // 规则 6(同年度叶合计 ≤ 年度预算)照常。
    const overAnnual = lumpPayload();
    overAnnual.annualBudgets = [{ year: 2026, amount: '500.00' }];
    await expect(createDraft(project.id, overAnnual, adminUser())).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('不得超过该年度初始预算'),
    });

    // 草稿:subjectTotalBudgets 被忽略。
    const { appId } = await createDraft(project.id, lumpPayload(), adminUser());
    expect(await prisma.subjectTotalBudget.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.subjectBudget.count({ where: { projectId: project.id } })).toBe(2);

    // 审批生效:三层 current ← initial;依旧无 STB。
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());
    const pb = await prisma.projectBudget.findUnique({ where: { projectId: project.id } });
    expect(pb!.currentAmount.toFixed(2)).toBe('1000.00');
    const ab = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
    });
    expect(ab!.currentAmount.toFixed(2)).toBe('1000.00');
    const sbs = await prisma.subjectBudget.findMany({ where: { projectId: project.id } });
    const sum = sumAmounts(sbs.map((s) => fromStored(s.currentAmount)));
    expect(sum.toFixed(2)).toBe('1000.00');
    expect(await prisma.subjectTotalBudget.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('调整:totalAdjustment ≠ 0 创建即 422;年度挪动照常且新增科目不建 STB;expandTotals 只涨项目总盘+年度盘子', async () => {
    const project = await createLumpProject('包干调整');
    const subjects = await approveLumpBudget(project.id);
    const leafA = subjects.get('A')!;
    const leafB = subjects.get('B')!;

    // 总维度调整 → 422。
    await expect(
      createAdjustment(
        project.id,
        {
          year: 2026,
          kind: 'ADJUST',
          lines: [
            { subjectId: leafA, totalAdjustment: '-100.00', annualAdjustment: '-100.00' },
            { subjectId: leafB, totalAdjustment: '100.00', annualAdjustment: '100.00' },
          ],
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('包干制项目不编制科目总预算'),
    });

    // 年度挪动 A→B 各 100:照常创建/提交/审批。
    const adj = await createAdjustment(
      project.id,
      {
        year: 2026,
        kind: 'ADJUST',
        annualReason: '年度内调剂',
        lines: [
          { subjectId: leafA, totalAdjustment: '0', annualAdjustment: '-100.00' },
          { subjectId: leafB, totalAdjustment: '0', annualAdjustment: '100.00' },
        ],
      },
      adminUser(),
    );
    await submitAdjustment(adj.id, adminUser());
    await approveAdjustment(adj.id, adminUser());
    const sbA = await prisma.subjectBudget.findUnique({
      where: { projectId_year_subjectId: { projectId: project.id, year: 2026, subjectId: leafA } },
    });
    expect(sbA!.currentAmount.toFixed(2)).toBe('500.00');
    // 审批后依旧无 STB。
    expect(await prisma.subjectTotalBudget.count({ where: { projectId: project.id } })).toBe(0);

    // ALLOCATE + expandTotals(新经费入账):项目总盘与年度盘子涨,无 STB 生成。
    const alloc = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        expandTotals: true,
        annualReason: '新经费入账',
        lines: [{ subjectId: leafA, totalAdjustment: '0', annualAdjustment: '300.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(alloc.id, adminUser());
    await approveAdjustment(alloc.id, adminUser());
    const pb = await prisma.projectBudget.findUnique({ where: { projectId: project.id } });
    expect(pb!.currentAmount.toFixed(2)).toBe('1300.00'); // 1000 + 300
    const ab2027 = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2027 } },
    });
    expect(ab2027!.currentAmount.toFixed(2)).toBe('300.00');
    const sbA27 = await prisma.subjectBudget.findUnique({
      where: { projectId_year_subjectId: { projectId: project.id, year: 2027, subjectId: leafA } },
    });
    expect(sbA27!.currentAmount.toFixed(2)).toBe('300.00');
    expect(await prisma.subjectTotalBudget.count({ where: { projectId: project.id } })).toBe(0);

    // 台账总口径回退:2027 年视图中叶 A 的 totalCurrent = 500(2026,调剂后) + 300(2027) = 800。
    const ledger = await getProjectLedger(project.id, 2027, adminUser());
    const nodeA = ledger.nodes.find((n) => n.subjectId === leafA)!;
    expect(nodeA.totalCurrent).toBe('800.00');
    expect(nodeA.current).toBe('300.00');

    // 结余统计:总预算口径 = Σ 各年度科目预算(A = 800),不依赖 STB;年份口径照常。
    const stats = await balanceStatistics({ projectId: project.id, year: 2027 }, adminUser());
    const rowA = stats.rows.find((r) => r.subjectId === leafA)!;
    expect(rowA.totalBudget).toBe('800.00');
    expect(rowA.yearBudget).toBe('300.00');
  });

  it('ALLOCATE 池内分配:容量护栏改为项目级(总预算 − Σ历年年度预算),超项目池 422', async () => {
    const project = await createLumpProject('包干项目池');
    // 编制留余额:总预算 1000,2026 年度只做 700(A 400 / B 300)→ 未分配池 = 300。
    const payload = lumpPayload();
    payload.annualBudgets = [{ year: 2026, amount: '700.00' }];
    payload.subjectBudgets = [
      payload.subjectBudgets[0], // A 600 → 改为 400
      payload.subjectBudgets[1],
    ];
    payload.subjectBudgets[0] = {
      year: 2026,
      subjectCode: 'A',
      amount: '400.00',
      unit: '次',
      quantity: '4.00',
      unitPrice: '100.00',
    };
    payload.subjectBudgets[1] = {
      year: 2026,
      subjectCode: 'B',
      amount: '300.00',
      unit: '次',
      quantity: '3.00',
      unitPrice: '100.00',
    };
    const { appId } = await createDraft(project.id, payload, adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());
    const leafA = (await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: 'A' },
    }))!.id;

    // 池内分配 200(≤ 300)→ 可提交可审批;池剩 100。
    const ok = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA, totalAdjustment: '0', annualAdjustment: '200.00' }],
      },
      adminUser(),
    );
    await submitAdjustment(ok.id, adminUser());
    await approveAdjustment(ok.id, adminUser());
    const ab2027 = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2027 } },
    });
    expect(ab2027!.currentAmount.toFixed(2)).toBe('200.00');

    // 再分配 200(> 池 100)→ 提交即拒绝(项目级护栏)。
    const over = await createAdjustment(
      project.id,
      {
        year: 2027,
        kind: 'ALLOCATE',
        lines: [{ subjectId: leafA, totalAdjustment: '0', annualAdjustment: '200.00' }],
      },
      adminUser(),
    );
    await expect(submitAdjustment(over.id, adminUser())).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('超出项目未分配额度'),
    });
  });
});
