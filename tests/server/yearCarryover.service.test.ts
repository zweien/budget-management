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
import { createProject } from '@/server/services/project.service';
import { createRecord, switchStatus } from '@/server/services/businessRecord.service';
import { carryOver } from '@/server/services/yearCarryover.service';

// 集成测试直连真实 PG(:5434)。建项目 + 两年度编制 + 业务记录,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
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
 * 构造合法 payload:1 根 + 1 叶 X,X 在 2026 与 2027 两年都有预算。
 * 默认两年各给 X 500,合计 1000(年度合计 ≤ 项目总额 1000)。
 */
function twoYearPayload(opts?: { x2026?: string; x2027?: string }): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [
      { year: 2026, amount: '500.00' },
      { year: 2027, amount: '500.00' },
    ],
    subjects: [
      { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
      { code: 'X', name: '叶X', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      // §enhance3:金额 = 数量 × 单价(service 端重算);此处令 quantity=金额、unitPrice=1,
      // 使 qty×price 仍等于原 amount(保持本测试既有的金额语义)。
      {
        year: 2026,
        subjectCode: 'X',
        amount: opts?.x2026 ?? '500.00',
        unit: '次',
        quantity: opts?.x2026 ?? '500.00',
        unitPrice: '1.00',
      },
      {
        year: 2027,
        subjectCode: 'X',
        amount: opts?.x2027 ?? '500.00',
        unit: '次',
        quantity: opts?.x2027 ?? '500.00',
        unitPrice: '1.00',
      },
    ],
    subjectTotalBudgets: [
      // X 跨两年合计:默认 1000(留余严格等于分配;若有 opts 则两段相加)。
      { subjectCode: 'X', amount: '1000.00' },
    ],
  };
}

describe('yearCarryover.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-carryover', role: UserRole.ADMIN },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 两年度编制 + 提交 + 审批生效 → 返回 { project, leafX }。 */
  async function seedTwoYearProject(suffix: string, opts?: { x2026?: string; x2027?: string }) {
    const code = `CY-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: `cy ${suffix}` },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, twoYearPayload(opts), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const leafX = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: 'X' },
    });
    if (!leafX) throw new Error('seed 失败:未找到叶 X');
    return { project, leafX };
  }

  it('carryOver 2026→2027: 结转非 PAID 记录;新记录 status/amount/remark 正确;原记录不变;双向 history 留痕', async () => {
    const { project, leafX } = await seedTwoYearProject('OK');

    // 2026 在 X 上登记一条 CONTRACT 记录(非 PAID,可结转)。
    const { record: src } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafX.id,
        amount: '100.00',
        businessDate: '2026-06-01',
        handler: '经办人X',
        summary: '待结转合同',
        status: BusinessStatus.CONTRACT,
        remark: '原始备注',
      },
      adminUser(),
    );

    const result = await carryOver(project.id, 2026, 2027, adminUser());

    // carriedCount = 1,无预警(2027 X 预算 500 > 100)。
    expect(result.carriedCount).toBe(1);
    expect(result.warnings).toEqual([]);

    // 2027 出现一条结转记录。
    const carried = await prisma.businessRecord.findMany({
      where: { projectId: project.id, budgetYear: 2027 },
    });
    expect(carried.length).toBe(1);
    const newRec = carried[0];
    expect(newRec.subjectId).toBe(leafX.id);
    expect(newRec.amount.toFixed(2)).toBe('100.00');
    expect(newRec.status).toBe(BusinessStatus.CONTRACT);
    expect(newRec.handler).toBe('经办人X');
    expect(newRec.summary).toBe('待结转合同');
    expect(newRec.businessDate.toISOString()).toBe(src.businessDate.toISOString());
    expect(newRec.remark).toContain('结转自2026');
    expect(newRec.remark).toContain('原始备注');
    expect(newRec.isVoid).toBe(false);

    // 原记录保持不变(仍存在、未作废、年度仍为 2026)。
    const srcStill = await prisma.businessRecord.findUnique({ where: { id: src.id } });
    expect(srcStill).not.toBeNull();
    expect(srcStill!.budgetYear).toBe(2026);
    expect(srcStill!.isVoid).toBe(false);
    expect(srcStill!.status).toBe(BusinessStatus.CONTRACT);
    expect(srcStill!.amount.toFixed(2)).toBe('100.00');

    // 原记录 history:carryover_out。
    const outHist = await prisma.businessRecordHistory.findFirst({
      where: { businessRecordId: src.id, action: 'carryover_out' },
    });
    expect(outHist).not.toBeNull();
    expect(outHist!.reason).toContain('2027');

    // 新记录 history:carryover_in(引用原 id)。
    const inHist = await prisma.businessRecordHistory.findFirst({
      where: { businessRecordId: newRec.id, action: 'carryover_in' },
    });
    expect(inHist).not.toBeNull();
    expect(inHist!.reason).toContain('2026');
    expect(inHist!.reason).toContain(src.id);
  });

  it('PAID 记录不结转(已支出不再占用新年度预算)', async () => {
    const { project, leafX } = await seedTwoYearProject('PAID');

    // 2026 在 X 上登记并切到 PAID。
    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafX.id,
        amount: '200.00',
        businessDate: '2026-07-01',
        handler: '经办人X',
        summary: '已支付',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );
    await switchStatus(record.id, BusinessStatus.PAID, adminUser());

    const result = await carryOver(project.id, 2026, 2027, adminUser());

    // 无可结转记录。
    expect(result.carriedCount).toBe(0);
    expect(result.warnings).toEqual([]);

    const carried = await prisma.businessRecord.findMany({
      where: { projectId: project.id, budgetYear: 2027 },
    });
    expect(carried.length).toBe(0);
  });

  it('预算不足预警: 2027 X 可用预算 < amount → warning 返回且记录仍创建', async () => {
    // 2027 X 预算给 50,结转金额 100 > 50。
    const { project, leafX } = await seedTwoYearProject('WARN', { x2027: '50.00' });

    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafX.id,
        amount: '100.00',
        businessDate: '2026-08-01',
        handler: '经办人X',
        summary: '超预算结转',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );

    const result = await carryOver(project.id, 2026, 2027, adminUser());

    expect(result.carriedCount).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].subjectCode).toBe('X');
    expect(result.warnings[0].reason).toContain('可用预算不足');

    // 记录仍创建(§8.4 超预算允许)。
    const carried = await prisma.businessRecord.findMany({
      where: { projectId: project.id, budgetYear: 2027 },
    });
    expect(carried.length).toBe(1);
    expect(carried[0].amount.toFixed(2)).toBe('100.00');
  });

  it('作废记录不结转(isVoid=true 跳过)', async () => {
    const { project, leafX } = await seedTwoYearProject('VOID');

    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafX.id,
        amount: '100.00',
        businessDate: '2026-09-01',
        handler: '经办人X',
        summary: '已作废不结转',
        status: BusinessStatus.CONTRACT,
      },
      adminUser(),
    );
    // 直接置为作废(走 prisma 绕开 voidRecord 的二次校验,简化 seed)。
    await prisma.businessRecord.update({
      where: { id: record.id },
      data: { isVoid: true, voidReason: 'test', voidedBy: adminId, voidedAt: new Date() },
    });

    const result = await carryOver(project.id, 2026, 2027, adminUser());
    expect(result.carriedCount).toBe(0);

    const carried = await prisma.businessRecord.findMany({
      where: { projectId: project.id, budgetYear: 2027 },
    });
    expect(carried.length).toBe(0);
  });

  it('fromYear === toYear 或逆序 → HTTPError 422', async () => {
    const { project } = await seedTwoYearProject('INVALID');

    await expect(carryOver(project.id, 2026, 2026, adminUser())).rejects.toMatchObject({
      status: 422,
    });
    await expect(carryOver(project.id, 2027, 2026, adminUser())).rejects.toMatchObject({
      status: 422,
    });
  });
});
