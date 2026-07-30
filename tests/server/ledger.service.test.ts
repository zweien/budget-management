import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, UserRole } from '@prisma/client';

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
import { getProjectLedger } from '@/server/services/ledger.service';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 审批 + 业务记录,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
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
 * 构造合法 payload:1 根(非叶)+ 2 叶(A/B),1 年度 2026。
 * A=600、B=400,合计 1000 = 年度/项目总额。
 */
function validPayload(): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [{ year: 2026, amount: '1000.00' }],
    subjects: [
      { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
      { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
      { code: 'B', name: '叶B', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      { year: 2026, subjectCode: 'A', amount: '600.00' },
      { year: 2026, subjectCode: 'B', amount: '400.00' },
    ],
  };
}

/** 直插一条 business_record(集成测试无需走 record service)。 */
async function insertRecord(input: {
  projectId: string;
  subjectId: string;
  budgetYear: number;
  amount: string;
  status: BusinessStatus;
  isVoid?: boolean;
  createdById: string;
}) {
  return prisma.businessRecord.create({
    data: {
      id: uuidv7(),
      projectId: input.projectId,
      budgetYear: input.budgetYear,
      subjectId: input.subjectId,
      amount: fromStored(input.amount),
      businessDate: new Date('2026-06-01'),
      handler: '测试经办人',
      summary: `记录-${input.status}`,
      status: input.status,
      isVoid: input.isVoid ?? false,
      createdById: input.createdById,
    },
  });
}

describe('ledger.service getProjectLedger (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  let outsiderId: string; // 无项目访问权(AUTHORIZED_HANDLER 但非该项目成员)

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t5', role: UserRole.BUDGET_ADMIN },
    });
    await prisma.user.create({
      data: { id: outsiderId, name: 'outsider-t5', role: UserRole.AUTHORIZED_HANDLER },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: [adminId, outsiderId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB, root }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `T5-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `t5 ${suffix}` }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    await submitDraft(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });
    await approveApplication(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const root = subjects.find((s) => s.code === 'ROOT')!;
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, appId, root, leafA, leafB };
  }

  it('叶节点占用正确(paid/payable/totalOccupied),balance = current - occupied,executionRate 正确(已审批 current=initial)', async () => {
    const { project, leafA } = await seedApprovedProject('LEAF');

    // 叶A 预算 600。插 3 条记录:PAID 100、CONTRACT 200、PAID 50 → paid=150, payable=200, occupied=350。
    await insertRecord({
      projectId: project.id,
      subjectId: leafA.id,
      budgetYear: 2026,
      amount: '100.00',
      status: BusinessStatus.PAID,
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: leafA.id,
      budgetYear: 2026,
      amount: '200.00',
      status: BusinessStatus.CONTRACT,
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: leafA.id,
      budgetYear: 2026,
      amount: '50.00',
      status: BusinessStatus.PAID,
      createdById: adminId,
    });

    const ledger = await getProjectLedger(project.id, 2026, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    expect(ledger.year).toBe(2026);

    const nodeA = ledger.nodes.find((n) => n.subjectId === leafA.id)!;
    expect(nodeA.isLeaf).toBe(true);
    // 已审批生效 → current = initial = 600,adjustment = 0。
    expect(nodeA.initial).toBe('600.00');
    expect(nodeA.current).toBe('600.00');
    expect(nodeA.adjustment).toBe('0.00');
    // 占用。
    expect(nodeA.paid).toBe('150.00');
    expect(nodeA.payable).toBe('200.00');
    expect(nodeA.totalOccupied).toBe('350.00');
    // 结余 = 600 - 350 = 250。
    expect(nodeA.balance).toBe('250.00');
    // 执行率 = 350 / 600 ≈ 0.5833...
    expect(nodeA.executionRate).toBeCloseTo(350 / 600, 10);
  });

  it('current=0 的叶节点 executionRate 为 null(除零保护);其余字段均为 0', async () => {
    // 用一个未审批的项目(createDraft 后 current=0)构造 current=0 叶节点。
    const code = `T5-ZERO-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't5 zero' }, { id: adminId });
    createdProjectIds.push(project.id);
    await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    // 注意:不 submit / approve → current=0。

    const ledger = await getProjectLedger(project.id, 2026, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    const leafA = ledger.nodes.find((n) => n.code === 'A')!;
    expect(leafA.current).toBe('0.00');
    expect(leafA.initial).toBe('600.00');
    expect(leafA.adjustment).toBe('-600.00'); // current(0) - initial(600)
    expect(leafA.executionRate).toBeNull();
    expect(leafA.paid).toBe('0.00');
    expect(leafA.payable).toBe('0.00');
    expect(leafA.totalOccupied).toBe('0.00');
    expect(leafA.balance).toBe('0.00');
  });

  it('父节点金额 = 叶子金额之和(上卷正确)', async () => {
    const { project, root, leafA, leafB } = await seedApprovedProject('ROLLUP');

    // A: PAID 60;B: CONTRACT 80。
    await insertRecord({
      projectId: project.id,
      subjectId: leafA.id,
      budgetYear: 2026,
      amount: '60.00',
      status: BusinessStatus.PAID,
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: leafB.id,
      budgetYear: 2026,
      amount: '80.00',
      status: BusinessStatus.CONTRACT,
      createdById: adminId,
    });

    const ledger = await getProjectLedger(project.id, 2026, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    const nodeA = ledger.nodes.find((n) => n.subjectId === leafA.id)!;
    const nodeB = ledger.nodes.find((n) => n.subjectId === leafB.id)!;
    const nodeRoot = ledger.nodes.find((n) => n.subjectId === root.id)!;

    expect(nodeRoot.isLeaf).toBe(false);
    // current = A.current(600) + B.current(400) = 1000。
    expect(nodeRoot.current).toBe('1000.00');
    expect(nodeRoot.initial).toBe('1000.00');
    // paid = 60(A),payable = 80(B),occupied = 140。
    expect(nodeRoot.paid).toBe('60.00');
    expect(nodeRoot.payable).toBe('80.00');
    expect(nodeRoot.totalOccupied).toBe('140.00');
    // balance = 1000 - 140 = 860。
    expect(nodeRoot.balance).toBe('860.00');
    // executionRate = 140 / 1000 = 0.14。
    expect(nodeRoot.executionRate).toBeCloseTo(0.14, 10);

    // parentId 链路存在(扁平数组,前端按 parentId 建树)。
    expect(nodeA.parentId).toBe(root.id);
    expect(nodeB.parentId).toBe(root.id);
    expect(nodeRoot.parentId).toBeNull();
  });

  it('作废记录不计入占用(isVoid=true 被排除)', async () => {
    const { project, leafA } = await seedApprovedProject('VOID');

    // 一条有效 PAID 100 + 一条作废 PAID 9999(应被排除)。
    await insertRecord({
      projectId: project.id,
      subjectId: leafA.id,
      budgetYear: 2026,
      amount: '100.00',
      status: BusinessStatus.PAID,
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: leafA.id,
      budgetYear: 2026,
      amount: '9999.00',
      status: BusinessStatus.PAID,
      isVoid: true,
      createdById: adminId,
    });

    const ledger = await getProjectLedger(project.id, 2026, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    const nodeA = ledger.nodes.find((n) => n.subjectId === leafA.id)!;
    // 作废的 9999 被排除 → paid=100,occupied=100。
    expect(nodeA.paid).toBe('100.00');
    expect(nodeA.totalOccupied).toBe('100.00');
    expect(nodeA.balance).toBe('500.00'); // 600 - 100
  });

  it('非项目访问者 → HTTPError 403(权限校验含项目范围)', async () => {
    const { project } = await seedApprovedProject('FORBID');

    await expect(
      getProjectLedger(project.id, 2026, { id: outsiderId, role: UserRole.AUTHORIZED_HANDLER }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('不同年度隔离:2027 年度无预算/无记录 → 全 0、executionRate null', async () => {
    const { project, leafA } = await seedApprovedProject('YEARISO');

    // 仅 2026 有记录。
    await insertRecord({
      projectId: project.id,
      subjectId: leafA.id,
      budgetYear: 2026,
      amount: '100.00',
      status: BusinessStatus.PAID,
      createdById: adminId,
    });

    const ledger2027 = await getProjectLedger(project.id, 2027, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    const nodeA2027 = ledger2027.nodes.find((n) => n.code === 'A')!;
    // 2027 没有 subject_budget → current=0,initial=0,executionRate=null。
    expect(nodeA2027.current).toBe('0.00');
    expect(nodeA2027.initial).toBe('0.00');
    expect(nodeA2027.executionRate).toBeNull();
    expect(nodeA2027.totalOccupied).toBe('0.00');
  });
});
