import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApprovalStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  createDraft,
  getDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';

// 集成测试直连真实 PG(:5434)。createDraft 在事务内建 application + 科目树 +
// 年度预算 + 叶节点预算,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

/** 构造一份合法的 payload:1 个根科目(非叶)+ 2 个叶科目,1 个年度。 */
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

  it('createDraft: 事务内建 application(DRAFT)+ 科目树 + 叶/年度预算 + ProjectBudget.initialAmount,current = initial', async () => {
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

    // 叶节点预算:initial = current,金额正确。
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
    expect(sbA!.currentAmount.toFixed(2)).toBe('600.00');
    expect(sbA!.adjustmentAmount.toFixed(2)).toBe('0.00');

    // 年度预算:initial = current = 1000。
    const annual = await prisma.annualBudget.findUnique({
      where: { projectId_year: { projectId: project.id, year: 2026 } },
    });
    expect(annual!.initialAmount.toFixed(2)).toBe('1000.00');
    expect(annual!.currentAmount.toFixed(2)).toBe('1000.00');

    // ProjectBudget.initialAmount 已回填(§6.3:current 仍为 0,审批生效才置位)。
    const pb = await prisma.projectBudget.findUnique({
      where: { projectId: project.id },
    });
    expect(pb!.initialAmount.toFixed(2)).toBe('1000.00');
    expect(pb!.currentAmount.toFixed(2)).toBe('0.00');

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
});
