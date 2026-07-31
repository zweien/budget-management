import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { BusinessStatus, Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { toStored } from '@/lib/decimal';
import { createProject } from '@/server/services/project.service';
import { EXCEL_COLUMNS, TEMPLATE_SHEET_NAME } from '@/lib/excel/template';
import {
  parseAndValidate,
  getImportBatch,
  confirmImport,
} from '@/server/services/excelImport.service';

/**
 * §10 Excel 导入集成测试(直连真实 PG :5434)。
 *
 * 用 exceljs 在内存中构造 .xlsx(行数据驱动),走完整 parse → preview → confirm 流程。
 * 每个用例建独立项目 + 科目,afterAll 级联清理。
 */

// ---------- helpers ----------

interface RowData {
  projectCode?: string;
  budgetYear?: number | string;
  subjectCode?: string;
  amount?: number | string;
  businessDate?: string;
  handler?: string;
  summary?: string;
  businessStatus?: string;
  remark?: string;
}

/** 用 exceljs 在内存中构造 .xlsx Buffer(单工作表,首行表头 + 数据行)。 */
async function buildXlsx(rows: RowData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(TEMPLATE_SHEET_NAME);
  ws.columns = EXCEL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  for (const r of rows) {
    ws.addRow({
      projectCode: r.projectCode ?? '',
      budgetYear: r.budgetYear ?? '',
      subjectCode: r.subjectCode ?? '',
      amount: r.amount ?? '',
      businessDate: r.businessDate ?? '',
      handler: r.handler ?? '',
      summary: r.summary ?? '',
      businessStatus: r.businessStatus ?? '',
      remark: r.remark ?? '',
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  // 先清业务记录历史/记录,再清导入批次行/批次,再到账/科目/预算,最后项目。
  await prisma.businessRecordHistory
    .deleteMany({
      where: { businessRecord: { projectId } },
    })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.importRow
    .deleteMany({
      where: { batch: { projectId } },
    })
    .catch(() => {});
  await prisma.importBatch.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('excelImport.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.BUDGET_ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-excel', role: UserRole.BUDGET_ADMIN },
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

  /** 建项目 + 直接插入科目(含一个非叶父科目 100 与一个叶科目 101)。返回 { project, leafCode, parentCode }。 */
  async function seedProject(suffix: string) {
    const code = `XI-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `excel ${suffix}` }, { id: adminId });
    createdProjectIds.push(project.id);

    const parentId = uuidv7();
    const leafId = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: parentId,
        projectId: project.id,
        parentId: null,
        code: '100',
        name: '父科目',
        level: 1,
        isLeaf: false,
      },
    });
    await prisma.budgetSubject.create({
      data: {
        id: leafId,
        projectId: project.id,
        parentId,
        code: '101',
        name: '叶科目',
        level: 2,
        isLeaf: true,
      },
    });
    return { project, leafCode: '101', parentCode: '100' };
  }

  it('parseAndValidate:合法文件 → 全部 valid;getImportBatch 三分组正确', async () => {
    const { project, leafCode } = await seedProject('OK');

    const buf = await buildXlsx([
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 1000,
        businessDate: '2026-07-01',
        handler: '张三',
        summary: '第一批',
        businessStatus: '登记占位',
        remark: '备注1',
      },
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 500.5,
        businessDate: '2026-07-15',
        handler: '李四',
        summary: '第二批',
        businessStatus: '已支出',
      },
    ]);

    const batchId = await parseAndValidate(buf, project.id, adminUser(), 'ok.xlsx');
    expect(batchId).toBeTruthy();

    const preview = await getImportBatch(batchId, adminUser());
    expect(preview.status).toBe('pending');
    expect(preview.valid.length).toBe(2);
    expect(preview.errors.length).toBe(0);
    expect(preview.duplicates.length).toBe(0);
    // 金额规范化为 2 位小数字符串。
    expect(preview.valid[0].normalizedAmount).toBe('1000.00');
    expect(preview.valid[1].normalizedAmount).toBe('500.50');
    // 状态映射。
    expect(preview.valid[0].normalizedStatus).toBe(BusinessStatus.PLACEHOLDER);
    expect(preview.valid[1].normalizedStatus).toBe(BusinessStatus.PAID);
  });

  it('parseAndValidate:非叶科目行 → error(错误定位到 subjectCode 字段)', async () => {
    const { project, leafCode, parentCode } = await seedProject('LEAF');

    const buf = await buildXlsx([
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 100,
        businessDate: '2026-07-01',
        handler: '张三',
        summary: '合法',
        businessStatus: '合同',
      },
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: parentCode, // 非叶科目
        amount: 200,
        businessDate: '2026-07-02',
        handler: '李四',
        summary: '非叶',
        businessStatus: '合同',
      },
    ]);

    const batchId = await parseAndValidate(buf, project.id, adminUser());
    const preview = await getImportBatch(batchId, adminUser());
    expect(preview.valid.length).toBe(1);
    expect(preview.errors.length).toBe(1);
    // 错误定位到 subjectCode。
    const errRow = preview.errors[0];
    expect(errRow.errors.some((e) => e.field === 'subjectCode')).toBe(true);
    expect(errRow.errors.some((e) => e.message.includes('叶节点'))).toBe(true);
  });

  it('parseAndValidate:与既有 business_record 完全匹配 → duplicateFlag=true(疑似重复)', async () => {
    const { project, leafCode } = await seedProject('DUP');

    // 预先插入一条 business_record(作 duplicate 基准)。
    const subject = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: leafCode },
    });
    expect(subject).not.toBeNull();
    const existingRecordId = uuidv7();
    await prisma.businessRecord.create({
      data: {
        id: existingRecordId,
        projectId: project.id,
        budgetYear: 2026,
        subjectId: subject!.id,
        amount: toStored(new Prisma.Decimal('300.00')) as unknown as Prisma.Decimal,
        businessDate: new Date('2026-06-10T00:00:00Z'),
        handler: '王五',
        summary: '重复基准',
        status: BusinessStatus.CONTRACT,
        isVoid: false,
        createdById: adminId,
      },
    });

    const buf = await buildXlsx([
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 300,
        businessDate: '2026-06-10',
        handler: '赵六', // 经办人不同不影响重复判定(摘要/金额/日期/科目/年度匹配即可)
        summary: '重复基准',
        businessStatus: '合同',
      },
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 999,
        businessDate: '2026-07-01',
        handler: '钱七',
        summary: '全新行',
        businessStatus: '登记占位',
      },
    ]);

    const batchId = await parseAndValidate(buf, project.id, adminUser());
    const preview = await getImportBatch(batchId, adminUser());
    // 重复行进 duplicates,全新行进 valid。
    expect(preview.duplicates.length).toBe(1);
    expect(preview.valid.length).toBe(1);
    expect(preview.duplicates[0].parsedData.summary).toBe('重复基准');
  });

  it('confirmImport:勾选有效行 → 创建 business_record;批次置 confirmed', async () => {
    const { project, leafCode } = await seedProject('CONFIRM');

    const buf = await buildXlsx([
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 150,
        businessDate: '2026-08-01',
        handler: '孙八',
        summary: '待导入A',
        businessStatus: '财务系统审批',
      },
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 250,
        businessDate: '2026-08-02',
        handler: '周九',
        summary: '待导入B',
        businessStatus: '已支出',
      },
    ]);

    const batchId = await parseAndValidate(buf, project.id, adminUser());
    const preview = await getImportBatch(batchId, adminUser());
    expect(preview.valid.length).toBe(2);

    // 勾选两行确认。
    const result = await confirmImport(
      batchId,
      preview.valid.map((r) => r.rowId),
      adminUser(),
    );
    expect(result.created).toBe(2);

    // business_records 真实写入。
    const records = await prisma.businessRecord.findMany({
      where: { projectId: project.id },
      orderBy: { amount: 'asc' },
    });
    expect(records.length).toBe(2);
    expect(records[0].amount.toFixed(2)).toBe('150.00');
    expect(records[0].status).toBe(BusinessStatus.FINANCE_APPROVAL);
    expect(records[1].status).toBe(BusinessStatus.PAID);

    // 批次状态。
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    expect(batch!.status).toBe('confirmed');
    expect(batch!.confirmedAt).not.toBeNull();

    // 审计 import 同事务写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: records[0].id, action: 'import', objectType: 'business_records' },
    });
    expect(audit).not.toBeNull();
  });

  it('confirmImport:勾选疑似重复行 → 创建记录且该行 forcedImport=true 留痕', async () => {
    const { project, leafCode } = await seedProject('FORCE');

    const subject = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, code: leafCode },
    });
    // 预先插入基准记录。
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId: project.id,
        budgetYear: 2026,
        subjectId: subject!.id,
        amount: toStored(new Prisma.Decimal('400.00')) as unknown as Prisma.Decimal,
        businessDate: new Date('2026-05-05T00:00:00Z'),
        handler: '基准',
        summary: '强制基准',
        status: BusinessStatus.PAID,
        isVoid: false,
        createdById: adminId,
      },
    });

    const buf = await buildXlsx([
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 400,
        businessDate: '2026-05-05',
        handler: '强制',
        summary: '强制基准',
        businessStatus: '合同',
      },
    ]);

    const batchId = await parseAndValidate(buf, project.id, adminUser());
    const preview = await getImportBatch(batchId, adminUser());
    expect(preview.duplicates.length).toBe(1);
    expect(preview.valid.length).toBe(0);

    // 用户手动勾选疑似重复行 → 强制导入。
    const dupRow = preview.duplicates[0];
    const result = await confirmImport(batchId, [dupRow.rowId], adminUser());
    expect(result.created).toBe(1);

    // 该 ImportRow.forcedImport=true。
    const row = await prisma.importRow.findUnique({ where: { id: dupRow.rowId } });
    expect(row!.forcedImport).toBe(true);

    // business_record 已创建(现在共 2 条:基准 + 强制导入)。
    const records = await prisma.businessRecord.findMany({
      where: { projectId: project.id, summary: '强制基准' },
    });
    expect(records.length).toBe(2); // 1 基准 + 1 强制导入
  });

  it('confirmImport:重复批次再次确认 → 409', async () => {
    const { project, leafCode } = await seedProject('RECONFIRM');

    const buf = await buildXlsx([
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 50,
        businessDate: '2026-09-01',
        handler: 'x',
        summary: '一次',
        businessStatus: '登记占位',
      },
    ]);
    const batchId = await parseAndValidate(buf, project.id, adminUser());
    const preview = await getImportBatch(batchId, adminUser());
    await confirmImport(
      batchId,
      preview.valid.map((r) => r.rowId),
      adminUser(),
    );

    // 再次确认 → 409。
    await expect(confirmImport(batchId, [], adminUser())).rejects.toMatchObject({ status: 409 });
  });

  it('parseAndValidate:非项目成员 → 403', async () => {
    const { project, leafCode } = await seedProject('PERM');
    const outsiderId = uuidv7();
    await prisma.user.create({
      data: { id: outsiderId, name: 'outsider-excel', role: UserRole.AUTHORIZED_HANDLER },
    });
    createdUserIds.push(outsiderId);

    const buf = await buildXlsx([
      {
        projectCode: project.code,
        budgetYear: 2026,
        subjectCode: leafCode,
        amount: 10,
        businessDate: '2026-07-01',
        handler: 'x',
        summary: 'y',
        businessStatus: '登记占位',
      },
    ]);
    await expect(
      parseAndValidate(buf, project.id, {
        id: outsiderId,
        role: UserRole.AUTHORIZED_HANDLER,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
