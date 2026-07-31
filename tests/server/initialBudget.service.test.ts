import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApprovalStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  createDraft,
  getDraft,
  submitDraft,
  updateDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';

// 集成测试直连真实 PG(:5434)。createDraft 在事务内建 application + 科目树 +
// 年度预算 + 叶节点预算,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
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

/** 构造一份合法的 payload:1 个根科目(非叶)+ 2 个叶科目,1 个年度。
 *  §B model:每个叶科目带一份跨年度总预算(A=600,B=400,合计=1000 ≤ projectTotal)。 */
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
    subjectTotalBudgets: [
      { subjectCode: 'A', amount: '600.00' },
      { subjectCode: 'B', amount: '400.00' },
    ],
  };
}

describe('initialBudget.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t3', role: UserRole.BUDGET_ADMIN },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('createDraft: 事务内建 application(DRAFT)+ 科目树 + 叶/年度预算 + ProjectBudget.initialAmount,current = 0(§6.3 审批生效才置位)', async () => {
    const code = `T3-OK-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 ok' }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });

    // application 状态 DRAFT。
    const app = await prisma.initialBudgetApplication.findUnique({ where: { id: appId } });
    expect(app).not.toBeNull();
    expect(app!.status).toBe(ApprovalStatus.DRAFT);
    expect(app!.applicantId).toBe(adminId);

    // 科目树:3 个,层级正确,父关系正确。
    const subjects = await prisma.budgetSubject.findMany({
      where: { projectId: project.id },
      include: { parent: true },
    });
    expect(subjects).toHaveLength(3);
    const root = subjects.find((s) => s.code === 'ROOT')!;
    expect(root.parentId).toBeNull();
    expect(root.isLeaf).toBe(false);
    expect(root.level).toBe(1);
    const leafA = subjects.find((s) => s.code === 'A')!;
    expect(leafA.parentId).toBe(root.id);
    expect(leafA.isLeaf).toBe(true);
    expect(leafA.level).toBe(2);

    // 叶节点预算:initial = 金额,current = 0(§6.3 审批生效才置位 current)。
    const sbA = await prisma.subjectBudget.findUnique({
      where: {
        projectId_year_subjectId: {
          projectId: project.id,
          year: 2026,
          subjectId: leafA.id,
        },
      },
    });
    expect(sbA!.initialAmount.toFixed(2)).toBe('600.00');
    expect(sbA!.currentAmount.toFixed(2)).toBe('0.00');
    expect(sbA!.adjustmentAmount.toFixed(2)).toBe('0.00');

    // 年度预算:initial = 1000,current = 0(§6.3 同上)。
    const annual = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
    });
    expect(annual!.initialAmount.toFixed(2)).toBe('1000.00');
    expect(annual!.currentAmount.toFixed(2)).toBe('0.00');

    // ProjectBudget.initialAmount 已回填(§6.3:current 仍为 0,审批生效才置位)。
    const pb = await prisma.projectBudget.findUnique({
      where: { projectId: project.id },
    });
    expect(pb!.initialAmount.toFixed(2)).toBe('1000.00');
    expect(pb!.currentAmount.toFixed(2)).toBe('0.00');

    // §B model 叶科目跨年度总预算:initial = 总预算,current = 0(§6.3 审批生效才置位)。
    const stA = await prisma.subjectTotalBudget.findUnique({
      where: {
        projectId_subjectId: { projectId: project.id, subjectId: leafA.id },
      },
    });
    expect(stA!.initialAmount.toFixed(2)).toBe('600.00');
    expect(stA!.currentAmount.toFixed(2)).toBe('0.00');
    expect(stA!.adjustmentAmount.toFixed(2)).toBe('0.00');
    const stAll = await prisma.subjectTotalBudget.findMany({
      where: { projectId: project.id },
    });
    expect(stAll).toHaveLength(2);

    // 审计同事务写入 create。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: appId, action: 'create' },
    });
    expect(audit).not.toBeNull();

    // getDraft 回填结构正确。
    const draft = await getDraft(project.id, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    expect(draft.id).toBe(appId);
    expect(draft.projectTotal).toBe('1000.00');
    expect(draft.subjects.find((s) => s.code === 'A')!.parentCode).toBe('ROOT');
    expect(draft.subjectBudgets.find((sb) => sb.subjectCode === 'A')!.amount).toBe('600.00');
    expect(draft.subjectTotalBudgets.find((st) => st.subjectCode === 'A')!.amount).toBe('600.00');
    expect(draft.subjectTotalBudgets).toHaveLength(2);
  });

  it('createDraft: §6.4 叶节点合计 > 年度 → HTTPError 422', async () => {
    const code = `T3-VIO-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 viol' }, { id: adminId });
    createdProjectIds.push(project.id);

    const bad = validPayload();
    // A=600 + B=400 合计 1000,把年度改成 900 → 叶节点合计超年度。
    bad.annualBudgets = [{ year: 2026, amount: '900.00' }];

    await expect(
      createDraft(project.id, bad, { id: adminId, role: UserRole.BUDGET_ADMIN }),
    ).rejects.toMatchObject({ status: 422 });

    // 校验失败不应留下任何编制数据。
    const apps = await prisma.initialBudgetApplication.findMany({
      where: { projectId: project.id },
    });
    expect(apps).toHaveLength(0);
  });

  it('createDraft: §B 规则1 — 叶科目跨年度总预算合计 > 项目总预算 → HTTPError 422', async () => {
    const code = `T3-ST1-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 st1' }, { id: adminId });
    createdProjectIds.push(project.id);

    const bad = validPayload();
    // 总预算合计 600+400=1000,把项目总预算改成 900(年度合计仍是 1000 会先触发规则2,
    // 所以同时压低年度分配,让规则2通过、只触发规则1)。
    bad.projectTotal = '900.00';
    bad.annualBudgets = [{ year: 2026, amount: '900.00' }];
    bad.subjectBudgets = [
      { year: 2026, subjectCode: 'A', amount: '500.00' },
      { year: 2026, subjectCode: 'B', amount: '400.00' },
    ];
    // 总预算合计仍 1000 > 900 → 规则1 触发。每个科目分配 ≤ 自己总预算(规则3 通过)。

    await expect(
      createDraft(project.id, bad, { id: adminId, role: UserRole.BUDGET_ADMIN }),
    ).rejects.toMatchObject({ status: 422 });

    const apps = await prisma.initialBudgetApplication.findMany({
      where: { projectId: project.id },
    });
    expect(apps).toHaveLength(0);
  });

  it('createDraft: §B 规则3 — 单个叶科目跨年度分配合计 > 其总预算 → HTTPError 422', async () => {
    const code = `T3-ST3-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 st3' }, { id: adminId });
    createdProjectIds.push(project.id);

    const bad = validPayload();
    // 给 A 两年的分配:600 + 500 = 1100,但其总预算只有 600 → 规则3 触发。
    bad.projectTotal = '2000.00';
    bad.annualBudgets = [
      { year: 2026, amount: '1100.00' },
      { year: 2027, amount: '500.00' },
    ];
    bad.subjectBudgets = [
      { year: 2026, subjectCode: 'A', amount: '600.00' },
      { year: 2026, subjectCode: 'B', amount: '400.00' }, // 合计 1000 ≤ 1100(规则2 通过)
      { year: 2027, subjectCode: 'A', amount: '500.00' }, // A 总分配 1100 > 600(规则3 触发)
    ];
    // 规则1:总预算合计 600+400=1000 ≤ 2000(通过)。

    await expect(
      createDraft(project.id, bad, { id: adminId, role: UserRole.BUDGET_ADMIN }),
    ).rejects.toMatchObject({ status: 422 });

    const apps = await prisma.initialBudgetApplication.findMany({
      where: { projectId: project.id },
    });
    expect(apps).toHaveLength(0);
  });

  it('createDraft: §B 留余额允许 — 分配合计 < 总预算(规则3 通过,不抛错)', async () => {
    const code = `T3-STOK-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 stok' }, { id: adminId });
    createdProjectIds.push(project.id);

    const ok = validPayload();
    // 总预算 A=1000 但只分配 600(留余额 400),合法。
    ok.projectTotal = '1400.00';
    ok.annualBudgets = [{ year: 2026, amount: '1000.00' }];
    ok.subjectTotalBudgets = [
      { subjectCode: 'A', amount: '1000.00' },
      { subjectCode: 'B', amount: '400.00' },
    ];
    // subjectBudgets 保持 A=600,B=400(合计 1000 ≤ 1000 年度,且 ≤ 各自总预算)。

    const { appId } = await createDraft(project.id, ok, {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    expect(appId).toBeDefined();

    const stA = await prisma.subjectTotalBudget.findFirst({
      where: { projectId: project.id, subject: { code: 'A' } },
    });
    expect(stA!.initialAmount.toFixed(2)).toBe('1000.00');
  });

  it('createDraft: 重复编制(同一项目再创建)→ HTTPError 409', async () => {
    const code = `T3-DUP-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 dup' }, { id: adminId });
    createdProjectIds.push(project.id);

    await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });

    await expect(
      createDraft(project.id, validPayload(), {
        id: adminId,
        role: UserRole.BUDGET_ADMIN,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('submitDraft: DRAFT → PENDING,submittedAt 置位,审计 submit', async () => {
    const code = `T3-SUB-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 sub' }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });

    const before = new Date();
    const result = await submitDraft(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });
    expect(result.status).toBe(ApprovalStatus.PENDING);

    const app = await prisma.initialBudgetApplication.findUnique({
      where: { id: appId },
    });
    expect(app!.status).toBe(ApprovalStatus.PENDING);
    expect(app!.submittedAt).not.toBeNull();
    expect(app!.submittedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const audit = await prisma.auditLog.findFirst({
      where: { objectId: appId, action: 'submit' },
    });
    expect(audit).not.toBeNull();
  });

  it('submitDraft: 非 DRAFT 状态(已 PENDING)再提交 → HTTPError 409', async () => {
    const code = `T3-RESUB-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 't3 resub' }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });
    await submitDraft(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });

    await expect(
      submitDraft(appId, { id: adminId, role: UserRole.BUDGET_ADMIN }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('updateDraft: 修改 DRAFT 草稿(重建科目/预算),current 仍为 0;PENDING 不可改→409', async () => {
    const code = `UPD-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: 'upd' }, { id: adminId });
    createdProjectIds.push(project.id);
    const { appId } = await createDraft(project.id, validPayload(), {
      id: adminId,
      role: UserRole.BUDGET_ADMIN,
    });

    // 修改:总预算改 2000,叶 A 改 1000(仍满足 §6.4)。
    const updated: InitialBudgetPayload = {
      projectTotal: '2000.00',
      annualBudgets: [{ year: 2026, amount: '2000.00' }],
      subjects: [
        { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
        { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
        { code: 'C', name: '叶C', parentCode: 'ROOT', isLeaf: true },
      ],
      subjectBudgets: [
        { year: 2026, subjectCode: 'A', amount: '1000.00' },
        { year: 2026, subjectCode: 'C', amount: '1000.00' },
      ],
      subjectTotalBudgets: [
        { subjectCode: 'A', amount: '1000.00' },
        { subjectCode: 'C', amount: '1000.00' },
      ],
    };
    const res = await updateDraft(appId, updated, { id: adminId, role: UserRole.BUDGET_ADMIN });
    expect(res.appId).toBe(appId);

    // 重建后:B 应被删除,C 应存在;A=1000;current 仍为 0(§6.3)。
    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    expect(subjects.find((s) => s.code === 'B')).toBeUndefined();
    expect(subjects.find((s) => s.code === 'C')).toBeDefined();
    const sbA = await prisma.subjectBudget.findFirst({
      where: { projectId: project.id, subject: { code: 'A' } },
    });
    expect(sbA?.initialAmount.toFixed(2)).toBe('1000.00');
    expect(sbA?.currentAmount.toFixed(2)).toBe('0.00');
    // 状态保持 DRAFT。
    const app = await prisma.initialBudgetApplication.findUnique({ where: { id: appId } });
    expect(app?.status).toBe(ApprovalStatus.DRAFT);

    // PENDING 不可改 → 提交后 updateDraft 应 409。
    await submitDraft(appId, { id: adminId, role: UserRole.BUDGET_ADMIN });
    await expect(
      updateDraft(appId, validPayload(), { id: adminId, role: UserRole.BUDGET_ADMIN }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
