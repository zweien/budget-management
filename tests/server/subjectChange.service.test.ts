import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApprovalStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';
import {
  approveSubjectChange,
  createSubjectChange,
  submitSubjectChange,
} from '@/server/services/subjectChange.service';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 审批 + 科目变更,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.subjectChangeApplication.deleteMany({ where: { projectId } }).catch(() => {});
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
 * 合法 payload:1 根(非叶)+ 2 叶(A/B),1 年度 2026。
 * A=600、B=400,合计 1000。
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
      // §enhance3:金额 = 数量 × 单价(service 端重算)。A 6×100=600;B 4×100=400。
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

describe('subjectChange.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t5', role: UserRole.BUDGET_ADMIN },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB, root }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `T5-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `t5 ${suffix}` }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const root = subjects.find((s) => s.code === 'ROOT')!;
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, root, leafA, leafB };
  }

  it('createSubjectChange rename A(已使用科目,允许改名)→ OK', async () => {
    const { project, leafA } = await seedApprovedProject('rename');
    const app = await createSubjectChange(
      project.id,
      {
        operations: [{ type: 'rename', subjectCode: 'A', newName: '叶A-改名' }],
      },
      adminUser(),
    );
    expect(app.status).toBe(ApprovalStatus.DRAFT);
    expect(app.id).toBeTruthy();
    // before/after 快照应同时存在。
    const before = app.beforeSnapshot as unknown as Array<{ code: string; name: string }>;
    const after = app.afterSnapshot as unknown as Array<{ code: string; name: string }>;
    const beforeA = before.find((n) => n.code === 'A')!;
    const afterA = after.find((n) => n.code === 'A')!;
    expect(beforeA.name).toBe('叶A');
    expect(afterA.name).toBe('叶A-改名');
    // 落库校验:尚未提交前 BudgetSubject 不变(草稿不影响实际数据)。
    const unchanged = await prisma.budgetSubject.findUnique({ where: { id: leafA.id } });
    expect(unchanged!.name).toBe('叶A');
  });

  it('createSubjectChange remove A(A 已有 subject_budget)→ 422 结构保护', async () => {
    const { project } = await seedApprovedProject('remove-protected');
    await expect(
      createSubjectChange(
        project.id,
        { operations: [{ type: 'remove', subjectCode: 'A' }] },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('createSubjectChange move A(A 已使用)→ 422 结构保护', async () => {
    const { project, root } = await seedApprovedProject('move-protected');
    // A 的 parent 是 ROOT,尝试把 A 移到 ROOT 顶级(parentCode=null)应触发结构保护。
    await expect(
      createSubjectChange(
        project.id,
        { operations: [{ type: 'move', subjectCode: 'A', newParentCode: null }] },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    // 防止 root 引用未使用警告(root 实际也未被使用,但测试重点是 A 的保护)
    expect(root).toBeTruthy();
  });

  it('createSubjectChange add 新叶 C(无预算)→ OK;approve 后 C 落地 BudgetSubject', async () => {
    const { project } = await seedApprovedProject('add');
    const app = await createSubjectChange(
      project.id,
      {
        operations: [
          { type: 'add', newCode: 'C', newName: '叶C', newParentCode: 'ROOT', isLeaf: true },
        ],
      },
      adminUser(),
    );
    expect(app.status).toBe(ApprovalStatus.DRAFT);

    // 提交 + 审批生效。
    const submitted = await submitSubjectChange(app.id, adminUser());
    expect(submitted.status).toBe(ApprovalStatus.PENDING);

    const approved = await approveSubjectChange(app.id, adminUser(), '同意新增');
    expect(approved.status).toBe(ApprovalStatus.APPROVED);

    // 验证 C 已落到 BudgetSubject。
    const c = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: 'C' },
    });
    expect(c).not.toBeNull();
    expect(c!.name).toBe('叶C');
    expect(c!.isLeaf).toBe(true);
  });

  it('approve 应用 rename:A 的 name 在 DB 中变化(PENDING→APPROVED)', async () => {
    const { project, leafA } = await seedApprovedProject('approve-rename');
    const app = await createSubjectChange(
      project.id,
      {
        operations: [{ type: 'rename', subjectCode: 'A', newName: '叶A-审批后' }],
      },
      adminUser(),
    );
    await submitSubjectChange(app.id, adminUser());
    const approved = await approveSubjectChange(app.id, adminUser(), '同意改名');
    expect(approved.status).toBe(ApprovalStatus.APPROVED);

    const a = await prisma.budgetSubject.findUnique({ where: { id: leafA.id } });
    expect(a!.name).toBe('叶A-审批后');
    // 关联预算保持不变(结构保护:rename 不动数据)。
    const sb = await prisma.subjectBudget.findFirst({
      where: { projectId: project.id, subjectId: leafA.id },
    });
    expect(sb).not.toBeNull();
  });

  it('approve 时复跑 §5.4:提交后新增 subject_budget 使科目变"已使用"→ 422', async () => {
    // 真正的 TOCTOU:① 添加全新叶 C(无预算,可删)并审批落地 ② 发起删除 C 的变更并提交
    // ③ 在 submit 与 approve 之间为 C 插入一条 subject_budget(使其变"已使用")
    // ④ approve 必须复跑结构保护 → 422,且 C 仍在 DB。
    const { project } = await seedApprovedProject('approve-rerun');

    // ① 添加叶 C 并审批。
    const addApp = await createSubjectChange(
      project.id,
      {
        operations: [
          { type: 'add', newCode: 'C', newName: '叶C', newParentCode: 'ROOT', isLeaf: true },
        ],
      },
      adminUser(),
    );
    await submitSubjectChange(addApp.id, adminUser());
    await approveSubjectChange(addApp.id, adminUser(), '新增 C');
    const subjC = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: 'C' },
    });
    expect(subjC).not.toBeNull();

    // ② 发起删除 C 的变更并提交(create 时 C 无 subject_budget,通过结构保护)。
    const removeApp = await createSubjectChange(
      project.id,
      { operations: [{ type: 'remove', subjectCode: 'C' }] },
      adminUser(),
    );
    await submitSubjectChange(removeApp.id, adminUser());

    // ③ 在 approve 前为 C 插入 subject_budget(模拟提交后有业务/预算占用)。
    await prisma.subjectBudget.create({
      data: {
        id: uuidv7(),
        projectId: project.id,
        year: 2026,
        subjectId: subjC!.id,
        initialAmount: 0,
        adjustmentAmount: 0,
        currentAmount: 0,
      },
    });

    // ④ approve 复跑 §5.4 → C 现已"已使用",删除被拒 → 422。
    await expect(approveSubjectChange(removeApp.id, adminUser())).rejects.toMatchObject({
      status: 422,
    });
    // C 仍在 DB(审批未生效)。
    const stillThere = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: 'C' },
    });
    expect(stillThere).not.toBeNull();
  });

  it('非 PENDING 状态审批→ 409', async () => {
    const { project } = await seedApprovedProject('state-conflict');
    const app = await createSubjectChange(
      project.id,
      {
        operations: [
          { type: 'add', newCode: 'E', newName: '叶E', newParentCode: 'ROOT', isLeaf: true },
        ],
      },
      adminUser(),
    );
    // DRAFT 直接 approve → 409。
    await expect(approveSubjectChange(app.id, adminUser())).rejects.toMatchObject({ status: 409 });
  });
});
