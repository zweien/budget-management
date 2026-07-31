import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
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
import { createRecord } from '@/server/services/businessRecord.service';
import { exportLedger, exportStatistics } from '@/server/services/export.service';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 业务记录,需级联清理。
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
 * 构造合法 payload:1 根(非叶)+ 2 叶(A/B),1 年度 2026。
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

describe('export.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-export', role: UserRole.BUDGET_ADMIN },
    });
    createdUserIds.push(adminId);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `EXP-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `export ${suffix}` }, { id: adminId });
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, leafA, leafB };
  }

  /** 用 exceljs 重新读回 Buffer,返回第一个工作表。 */
  async function readSheet(buffer: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    return wb.worksheets[0];
  }

  // ---------------- exportLedger ----------------

  it('exportLedger: 返回 Buffer;元信息行含导出时间/年度;表头匹配;至少一行数据', async () => {
    const { project, leafA } = await seedApprovedProject('LED');
    // 加一条记录让数据非空。
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '150.00',
        businessDate: '2026-05-10',
        handler: '经办人A',
        summary: 'rec-led',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    const buffer = await exportLedger(project.id, 2026, adminUser());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);

    const sheet = await readSheet(buffer);

    // 把前若干行的 A 列文本拼起来,用于断言元信息存在。
    const topTexts: string[] = [];
    for (let r = 1; r <= 6; r++) {
      const v = sheet.getCell(`A${r}`).value;
      topTexts.push(v == null ? '' : String(v));
    }
    const metaBlob = topTexts.join('\n');
    // 元信息:含「导出时间」和「年度:2026」。
    expect(metaBlob).toContain('导出时间');
    expect(metaBlob).toContain('年度:2026');
    // 操作人 = admin-export(user.name)。
    expect(metaBlob).toContain('admin-export');
    // 项目编号/名称。
    expect(metaBlob).toContain(project.code);

    // 找到表头行(第 6 行)。断言表头匹配。
    const headerRow = sheet.getRow(6);
    const headerValues = headerRow.values as unknown[];
    // exceljs 行 values 数组第 0 位是占位(spacer),从 1 起。
    const headers = headerValues.slice(1).map((v) => (v == null ? '' : String(v)));
    expect(headers).toEqual([
      '预算科目',
      '初始预算',
      '预算调整',
      '当前预算',
      '已支出',
      '应付未付',
      '总占用',
      '结余',
      '执行率',
    ]);

    // 至少一行数据(项目含 ROOT + A + B = 3 行)。
    const dataRowA = sheet.getRow(7).values as unknown[];
    expect(dataRowA.length).toBeGreaterThan(1);
    // 第 1 列(预算科目)非空。
    expect(String(dataRowA[1] ?? '').length).toBeGreaterThan(0);

    // 在数据区域能找到叶 A 的科目名(可能带缩进前缀,但应含「叶A」)。
    let foundLeafA = false;
    for (let r = 7; r <= 7 + 16; r++) {
      const v = sheet.getCell(`A${r}`).value;
      if (v != null && String(v).includes('叶A')) {
        foundLeafA = true;
        break;
      }
    }
    expect(foundLeafA).toBe(true);

    // 叶 A 初始预算 600,应能在某数据行第 2 列找到 600.00。
    let foundAInitial = false;
    for (let r = 7; r <= 7 + 16; r++) {
      const subject = sheet.getCell(`A${r}`).value;
      if (subject != null && String(subject).includes('叶A')) {
        const initial = sheet.getCell(`B${r}`).value;
        if (String(initial) === '600.00') foundAInitial = true;
      }
    }
    expect(foundAInitial).toBe(true);
  });

  it('exportLedger: 非项目访问者 → 403(权限由 getProjectLedger 再校验)', async () => {
    const { project } = await seedApprovedProject('PERM');
    const outsiderId = uuidv7();
    await prisma.user.create({
      data: { id: outsiderId, name: 'outsider-export', role: UserRole.AUTHORIZED_HANDLER },
    });
    createdUserIds.push(outsiderId);

    await expect(
      exportLedger(project.id, 2026, { id: outsiderId, role: UserRole.AUTHORIZED_HANDLER }),
    ).rejects.toMatchObject({ status: 403 });
  });

  // ---------------- exportStatistics ----------------

  it('exportStatistics: 返回 Buffer;元信息含筛选条件/导出时间;汇总区+明细表头+明细行', async () => {
    const { project, leafA } = await seedApprovedProject('STAT');
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '200.00',
        businessDate: '2026-06-20',
        handler: '经办人A',
        summary: 'rec-stat',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    const buffer = await exportStatistics({ projectId: project.id, budgetYear: 2026 }, adminUser());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);

    const sheet = await readSheet(buffer);

    // 元信息区(A1 筛选条件 / A2 导出时间 / A3 操作人)。
    const a1 = String(sheet.getCell('A1').value ?? '');
    const a2 = String(sheet.getCell('A2').value ?? '');
    const a3 = String(sheet.getCell('A3').value ?? '');
    expect(a1).toContain('筛选条件');
    expect(a1).toContain('年度=2026');
    expect(a2).toContain('导出时间');
    expect(a3).toContain('admin-export');

    // 汇总区(第 5 行起 6 行):找含「执行率」的汇总键。
    let summaryHasExecution = false;
    for (let r = 5; r <= 11; r++) {
      const k = String(sheet.getCell(`A${r}`).value ?? '');
      if (k === '执行率') summaryHasExecution = true;
    }
    expect(summaryHasExecution).toBe(true);

    // 明细表头行(含「金额」「业务状态」)。
    let headerFound = false;
    let headerRowNum = 0;
    for (let r = 5; r <= 40; r++) {
      const vals = (sheet.getRow(r).values as unknown[])
        .slice(1)
        .map((v) => (v == null ? '' : String(v)));
      if (vals.includes('金额') && vals.includes('业务状态') && vals.includes('科目编码')) {
        headerFound = true;
        headerRowNum = r;
        break;
      }
    }
    expect(headerFound).toBe(true);

    // 明细数据行至少一条,且金额列含 200.00。
    let foundAmount = false;
    for (let r = headerRowNum + 1; r <= headerRowNum + 50; r++) {
      // 找到金额列下标(表头第几列是「金额」)。
      const headerVals = (sheet.getRow(headerRowNum).values as unknown[]).slice(1);
      const amountIdx = headerVals.findIndex((v) => v != null && String(v) === '金额') + 1;
      const amt = sheet.getCell(r, amountIdx).value;
      if (amt != null && String(amt) === '200.00') {
        foundAmount = true;
        break;
      }
    }
    expect(foundAmount).toBe(true);
  });

  it('exportStatistics: 跨项目(无 projectId)非 admin → 403', async () => {
    const outsiderId = uuidv7();
    await prisma.user.create({
      data: { id: outsiderId, name: 'outsider-stat-export', role: UserRole.AUTHORIZED_HANDLER },
    });
    createdUserIds.push(outsiderId);

    await expect(
      exportStatistics({}, { id: outsiderId, role: UserRole.AUTHORIZED_HANDLER }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
