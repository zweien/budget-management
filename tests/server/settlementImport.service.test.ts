import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { BusinessStatus, Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { toStored } from '@/lib/decimal';
import { createProject } from '@/server/services/project.service';
import { EXCEL_COLUMNS, TEMPLATE_SHEET_NAME } from '@/lib/excel/template';
import { SETTLEMENT_TEMPLATE_VERSION } from '@/lib/excel/settlement';
import {
  loadSettlementWorkbookIfMatch,
  parseSettlement,
  getSettlementBatch,
  updateSettlementRows,
  confirmSettlementImport,
  listImportBatches,
} from '@/server/services/settlementImport.service';
import { parseAndValidate } from '@/server/services/excelImport.service';

/**
 * 个人结算单 Excel 导入集成测试(直连真实 PG :5434)。
 *
 * 用 exceljs 在内存中构造「个人结算单查询」格式(表头第 4 行),
 * 走完整 detect → parse → 暂存(科目指定)→ confirm 流程。
 */

// ---------- helpers ----------

interface SettlementRowData {
  docNo?: string;
  docStatus?: string;
  fillDate?: string;
  /** 传 richText: true 时以富文本对象写入(覆盖常见导出格式)。 */
  subject?: string;
  richText?: boolean;
  amount?: number | string;
  handler?: string;
}

const SETTLEMENT_HEADERS_ROW = [
  '单据编号',
  '单据状态',
  '单位',
  '部门',
  '单据类型',
  '业务类型',
  '填制日期',
  '应偿还日期',
  '合同编号',
  '事项',
  '金额',
  '制单人',
  '经办人',
  '摘要预览',
  '科目/项目',
  '附件张数',
];

/** 构造「个人结算单查询」格式 xlsx:前 3 行元信息 + 第 4 行表头 + 数据行。 */
async function buildSettlementXlsx(rows: SettlementRowData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('个人结算单查询');
  ws.addRow(['个人结算单查询']);
  ws.addRow(['时间:2026年08月31日']);
  ws.addRow(['单位:计算机学院']);
  ws.addRow(SETTLEMENT_HEADERS_ROW);
  for (const r of rows) {
    const row = ws.addRow([
      r.docNo ?? '',
      r.docStatus ?? '',
      '计算机学院',
      '研发中心',
      '通用报销',
      '零星采购经费',
      r.fillDate ?? '',
      '',
      '',
      r.richText
        ? {
            richText: [
              { font: { bold: true }, text: '（出版文献事务费）' },
              { text: r.subject ?? '' },
            ],
          }
        : (r.subject ?? ''),
      r.amount ?? '',
      '研发中心',
      r.handler ?? '',
      '',
      '',
      '',
    ]);
    if (r.richText) {
      row.getCell(10).value = {
        richText: [{ font: { bold: true }, text: '（出版文献事务费）' }, { text: r.subject ?? '' }],
      };
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/** 构造「表头不全」的结算单 xlsx(回归:缺必要列必须 422,不得静默回退 A 列)。 */
async function buildPartialHeaderXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('个人结算单查询');
  ws.addRow(['个人结算单查询']);
  ws.addRow(['时间:2026年08月31日']);
  ws.addRow(['单位:计算机学院']);
  ws.addRow(['单据编号', '单据状态', '填制日期']);
  ws.addRow(['TY-X', '完成记账', '2026-08-01']);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/** 标准模板 xlsx(验证不会被误判为结算单格式)。 */
async function buildStandardXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(TEMPLATE_SHEET_NAME);
  ws.columns = EXCEL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.addRow({
    projectCode: 'X',
    budgetYear: 2026,
    subjectCode: '101',
    amount: 100,
    businessDate: '2026-01-01',
    handler: '甲',
    summary: 's',
    businessStatus: '已支出',
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecordHistory
    .deleteMany({ where: { businessRecord: { projectId } } })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.importRow.deleteMany({ where: { batch: { projectId } } }).catch(() => {});
  await prisma.importBatch.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('settlementImport.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let leafId = '';
  let leafId2 = '';
  let parentId = '';
  let projectId = '';
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-settle', role: UserRole.ADMIN },
    });
    createdUserIds.push(adminId);

    const project = await createProject(
      { code: `STL-${uuidv7().slice(0, 8)}`, name: '结算单导入测试' },
      adminUser(),
    );
    createdProjectIds.push(project.id);
    projectId = project.id;

    parentId = uuidv7();
    leafId = uuidv7();
    leafId2 = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: parentId,
        projectId,
        parentId: null,
        code: '100',
        name: '父',
        level: 1,
        isLeaf: false,
      },
    });
    await prisma.budgetSubject.create({
      data: {
        id: leafId,
        projectId,
        parentId,
        code: '101',
        name: '材料费',
        level: 2,
        isLeaf: true,
      },
    });
    await prisma.budgetSubject.create({
      data: {
        id: leafId2,
        projectId,
        parentId,
        code: '102',
        name: '会议费',
        level: 2,
        isLeaf: true,
      },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('格式识别:结算单命中,标准模板不误判', async () => {
    const stl = await buildSettlementXlsx([
      {
        docNo: 'D1',
        docStatus: '完成记账',
        fillDate: '2026-08-01',
        subject: 'x',
        amount: 100,
        handler: '甲',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(stl);
    expect(wb).not.toBeNull();

    const std = await buildStandardXlsx();
    expect(await loadSettlementWorkbookIfMatch(std)).toBeNull();
  });

  it('parse:缺少必要列表头 → 422(不回退 A 列)', async () => {
    const buf = await buildPartialHeaderXlsx();
    const wb = await loadSettlementWorkbookIfMatch(buf);
    expect(wb).not.toBeNull(); // 检测头命中,但必要列不全
    await expect(parseSettlement(wb!, projectId, adminUser())).rejects.toMatchObject({
      status: 422,
    });
  });

  it('parse:状态映射/退单跳过/年度推导/富文本拍平/错误行', async () => {
    const buf = await buildSettlementXlsx([
      {
        docNo: 'TY1',
        docStatus: '完成记账',
        fillDate: '2026-08-25',
        subject: '大模型token',
        amount: '1700',
        handler: '刘雅婧',
      },
      {
        docNo: 'TY2',
        docStatus: '制单保存',
        fillDate: '2026-07-03',
        subject: '评价会会议费',
        amount: '280.5',
        handler: '李国朕',
      },
      {
        docNo: 'TY3',
        docStatus: '业务退单',
        fillDate: '2026-07-15',
        subject: '退单据',
        amount: '2738.31',
        handler: '王鹏宇',
      },
      {
        docNo: 'TY4',
        docStatus: '完成记账',
        fillDate: '2026-04-23',
        subject: '高拍仪',
        richText: true,
        amount: '1055.12',
        handler: '白伟光',
      },
      {
        docNo: 'TY5',
        docStatus: '神秘状态',
        fillDate: '2026-01-01',
        subject: 's',
        amount: '10',
        handler: '乙',
      },
      {
        docNo: 'TY6',
        docStatus: '完成记账',
        fillDate: 'not-a-date',
        subject: 's',
        amount: '10',
        handler: '乙',
      },
      {
        docNo: 'TY7',
        docStatus: '完成记账',
        fillDate: '2026-01-02',
        subject: 's',
        amount: '-5',
        handler: '乙',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    expect(wb).not.toBeNull();
    const batchId = await parseSettlement(wb!, projectId, adminUser(), 'sample.xlsx');

    const preview = await getSettlementBatch(batchId, adminUser());
    expect(preview.templateVersion).toBe(SETTLEMENT_TEMPLATE_VERSION);
    // 待导入:TY1/TY2/TY4;重复:无;错误:TY5/TY6/TY7;跳过:TY3。
    expect(preview.pending).toHaveLength(3);
    expect(preview.duplicates).toHaveLength(0);
    expect(preview.errors).toHaveLength(3);
    expect(preview.skippedCount).toBe(1);

    const ty1 = preview.pending.find((r) => r.parsedData.docNo === 'TY1')!;
    expect(ty1.parsedData.status).toBe(BusinessStatus.PAID);
    expect(ty1.parsedData.budgetYear).toBe(2026);
    expect(ty1.validationStatus).toBe('valid');
    const ty2 = preview.pending.find((r) => r.parsedData.docNo === 'TY2')!;
    expect(ty2.parsedData.status).toBe(BusinessStatus.FINANCE_APPROVAL);
    expect(ty2.normalizedAmount).toBe('280.50');
    const ty4 = preview.pending.find((r) => r.parsedData.docNo === 'TY4')!;
    // 富文本拍平:粗体前缀 + 正文拼接。
    expect(ty4.parsedData.summary).toBe('（出版文献事务费）高拍仪');

    expect(preview.errors.map((r) => r.rowNo).sort()).toEqual(
      preview.errors.map((r) => r.rowNo).sort(),
    );
    const errFields = preview.errors.flatMap((r) => r.errors.map((e) => e.field));
    expect(errFields).toContain('docStatus');
    expect(errFields).toContain('fillDate');
    expect(errFields).toContain('amount');

    // docNo 非必填:解析不因缺单据编号报错。
    const buf2 = await buildSettlementXlsx([
      {
        docStatus: '完成记账',
        fillDate: '2026-02-02',
        subject: '无单号',
        amount: '66',
        handler: '丙',
      },
    ]);
    const wb2 = await loadSettlementWorkbookIfMatch(buf2);
    const batchId2 = await parseSettlement(wb2!, projectId, adminUser());
    const p2 = await getSettlementBatch(batchId2, adminUser());
    expect(p2.pending).toHaveLength(1);
    expect(p2.pending[0].parsedData.docNo).toBeNull();

    // 批次列表可见。
    const list = await listImportBatches(projectId, adminUser());
    expect(list.map((b) => b.batchId)).toContain(batchId);
    expect(list.map((b) => b.batchId)).toContain(batchId2);
  });

  it('parse:docNo 命中既有记录 → 疑似重复;无 docNo 退回指纹', async () => {
    // 既有记录:docNo EXIST-1;以及一条供指纹匹配的(2026-03-03/88/指纹摘要)。
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        budgetYear: 2026,
        subjectId: leafId,
        amount: toStored(new Prisma.Decimal('500')),
        businessDate: new Date('2026-03-03T00:00:00Z'),
        handler: '旧经办',
        summary: '指纹摘要',
        status: BusinessStatus.PAID,
        docNo: 'EXIST-1',
        createdById: adminId,
      },
    });
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        budgetYear: 2026,
        subjectId: leafId,
        amount: toStored(new Prisma.Decimal('88')),
        businessDate: new Date('2026-03-04T00:00:00Z'),
        handler: '旧经办',
        summary: '无单号指纹命中',
        status: BusinessStatus.PAID,
        createdById: adminId,
      },
    });

    const buf = await buildSettlementXlsx([
      {
        docNo: 'EXIST-1',
        docStatus: '完成记账',
        fillDate: '2026-03-03',
        subject: '重复单',
        amount: '500',
        handler: '旧经办',
      },
      {
        docStatus: '完成记账',
        fillDate: '2026-03-04',
        subject: '无单号指纹命中',
        amount: '88',
        handler: '旧经办',
      },
      {
        docNo: 'BRAND-NEW',
        docStatus: '完成记账',
        fillDate: '2026-03-05',
        subject: '新单',
        amount: '10',
        handler: '丁',
      },
      // 文件内重复 docNo(第 2 次出现)。
      {
        docNo: 'DUP-IN-FILE',
        docStatus: '完成记账',
        fillDate: '2026-03-06',
        subject: '第一次',
        amount: '11',
        handler: '丁',
      },
      {
        docNo: 'DUP-IN-FILE',
        docStatus: '完成记账',
        fillDate: '2026-03-07',
        subject: '第二次',
        amount: '12',
        handler: '丁',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(wb!, projectId, adminUser());
    const preview = await getSettlementBatch(batchId, adminUser());

    const dupDocNos = preview.duplicates.map((r) => r.parsedData.docNo);
    expect(dupDocNos).toContain('EXIST-1'); // docNo 命中 DB
    expect(
      preview.duplicates.some(
        (r) => !r.parsedData.docNo && r.parsedData.summary === '无单号指纹命中',
      ),
    ).toBe(true); // 指纹兜底
    expect(dupDocNos).toContain('DUP-IN-FILE'); // 文件内重复(第 2 次)
    expect(preview.pending.map((r) => r.parsedData.docNo)).toContain('BRAND-NEW');
  });

  it('暂存:科目指定/年度修改/非法输入/确认', async () => {
    const buf = await buildSettlementXlsx([
      {
        docNo: 'CF-1',
        docStatus: '完成记账',
        fillDate: '2026-05-01',
        subject: '第一条',
        amount: '120.4',
        handler: '戊',
      },
      {
        docNo: 'CF-2',
        docStatus: '制单保存',
        fillDate: '2026-06-11',
        subject: '第二条',
        amount: '30',
        handler: '己',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(wb!, projectId, adminUser());
    const preview = await getSettlementBatch(batchId, adminUser());
    const rows = preview.pending;

    // 未指定科目不能确认。
    await expect(
      confirmSettlementImport(
        batchId,
        rows.map((r) => r.rowId),
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });

    // 非叶科目 → 422;外项目科目 → 422;非法年度 → 422。
    await expect(
      updateSettlementRows(batchId, [{ rowId: rows[0].rowId, subjectId: parentId }], adminUser()),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      updateSettlementRows(batchId, [{ rowId: rows[0].rowId, subjectId: uuidv7() }], adminUser()),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      updateSettlementRows(batchId, [{ rowId: rows[0].rowId, budgetYear: 100 }], adminUser()),
    ).rejects.toMatchObject({ status: 422 });

    // 暂存:指定科目 + 改年度。
    await updateSettlementRows(
      batchId,
      [
        { rowId: rows[0].rowId, subjectId: leafId, budgetYear: 2025 },
        { rowId: rows[1].rowId, subjectId: leafId2 },
      ],
      adminUser(),
    );
    const afterSave = await getSettlementBatch(batchId, adminUser());
    const saved1 = afterSave.pending.find((r) => r.rowId === rows[0].rowId)!;
    expect(saved1.parsedData.subjectId).toBe(leafId);
    expect(saved1.parsedData.subjectName).toBe('材料费');
    expect(saved1.parsedData.budgetYear).toBe(2025);

    // 确认入库。
    const res = await confirmSettlementImport(
      batchId,
      afterSave.pending.map((r) => r.rowId),
      adminUser(),
    );
    expect(res.created).toBe(2);

    const recs = await prisma.businessRecord.findMany({
      where: { projectId, docNo: { in: ['CF-1', 'CF-2'] } },
    });
    expect(recs).toHaveLength(2);
    const rec1 = recs.find((r) => r.docNo === 'CF-1')!;
    expect(rec1.subjectId).toBe(leafId);
    expect(rec1.budgetYear).toBe(2025);
    expect(rec1.status).toBe(BusinessStatus.PAID);
    expect(rec1.amount.toFixed(2)).toBe('120.40');
    expect(rec1.businessDate.toISOString().slice(0, 10)).toBe('2026-05-01');
    const rec2 = recs.find((r) => r.docNo === 'CF-2')!;
    expect(rec2.status).toBe(BusinessStatus.FINANCE_APPROVAL);
    expect(rec2.budgetYear).toBe(2026);

    // 审计 import 已写。
    const audit = await prisma.auditLog.findFirst({
      where: { projectId, objectType: 'business_records', action: 'import', objectId: rec1.id },
    });
    expect(audit).not.toBeNull();

    // 批次已确认:再次确认 409,再修改 409。
    await expect(
      confirmSettlementImport(batchId, [rows[0].rowId], adminUser()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateSettlementRows(batchId, [{ rowId: rows[0].rowId, subjectId: leafId2 }], adminUser()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('确认:docNo 硬重复禁止导入(不可强制);指纹疑似可强制;确认前 docNo 冲突兜底', async () => {
    // 既有 docNo FORCE-1(硬重复源)+ 指纹命中源(无编号:2026-07-10/33/「指纹命中源」)。
    await prisma.businessRecord.createMany({
      data: [
        {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: toStored(new Prisma.Decimal('1')),
          businessDate: new Date('2026-01-01T00:00:00Z'),
          handler: '旧',
          summary: '已有单据',
          status: BusinessStatus.PAID,
          docNo: 'FORCE-1',
          createdById: adminId,
        },
        {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: toStored(new Prisma.Decimal('33')),
          businessDate: new Date('2026-07-10T00:00:00Z'),
          handler: '旧',
          summary: '指纹命中源',
          status: BusinessStatus.PAID,
          createdById: adminId,
        },
      ],
    });
    const buf = await buildSettlementXlsx([
      {
        docNo: 'FORCE-1',
        docStatus: '完成记账',
        fillDate: '2026-07-08',
        subject: '硬重复单',
        amount: '20',
        handler: '庚',
      },
      {
        docNo: 'RACE-1',
        docStatus: '完成记账',
        fillDate: '2026-07-09',
        subject: '竞态单',
        amount: '21',
        handler: '庚',
      },
      {
        docStatus: '完成记账',
        fillDate: '2026-07-10',
        subject: '指纹命中源',
        amount: '33',
        handler: '庚',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(wb!, projectId, adminUser());
    const preview = await getSettlementBatch(batchId, adminUser());
    const hardRow = preview.duplicates.find((r) => r.parsedData.docNo === 'FORCE-1')!;
    const susRow = preview.duplicates.find((r) => !r.parsedData.docNo)!;
    const okRow = preview.pending.find((r) => r.parsedData.docNo === 'RACE-1')!;
    expect(hardRow.duplicateLevel).toBe('hard');
    expect(susRow.duplicateLevel).toBe('suspected');

    await updateSettlementRows(
      batchId,
      [
        { rowId: hardRow.rowId, subjectId: leafId },
        { rowId: susRow.rowId, subjectId: leafId },
        { rowId: okRow.rowId, subjectId: leafId },
      ],
      adminUser(),
    );

    // 硬重复行不可强制导入(暂存即拒)。
    await expect(
      updateSettlementRows(batchId, [{ rowId: hardRow.rowId, forcedImport: true }], adminUser()),
    ).rejects.toMatchObject({ status: 422 });

    // 硬重复行确认 → 422(即使强行把 forcedImport 写进选中集也拦)。
    await expect(
      confirmSettlementImport(batchId, [hardRow.rowId, susRow.rowId], adminUser()),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('硬重复') });

    // 疑似重复行未强制 → 422。
    await expect(
      confirmSettlementImport(batchId, [susRow.rowId], adminUser()),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('疑似重复') });

    // 疑似重复行强制导入 + 竞态:确认前他人导入同 docNo(RACE-1)→ 兜底 422(硬重复无豁免)。
    await updateSettlementRows(batchId, [{ rowId: susRow.rowId, forcedImport: true }], adminUser());
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        budgetYear: 2026,
        subjectId: leafId,
        amount: toStored(new Prisma.Decimal('99')),
        businessDate: new Date('2026-07-09T00:00:00Z'),
        handler: '别人',
        summary: '抢先入库',
        status: BusinessStatus.PAID,
        docNo: 'RACE-1',
        createdById: adminId,
      },
    });
    await expect(
      confirmSettlementImport(batchId, [susRow.rowId, okRow.rowId], adminUser()),
    ).rejects.toMatchObject({ status: 422 });

    // 只导入强制疑似行(取消 RACE-1 勾选)→ 成功。
    const res = await confirmSettlementImport(batchId, [susRow.rowId], adminUser());
    expect(res.created).toBe(1);
    const importRow = await prisma.importRow.findFirst({ where: { batchId, rowNo: susRow.rowNo } });
    expect(importRow?.forcedImport).toBe(true);
  });

  it('标准模板导入不受影响(parseAndValidate 正常分流)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(TEMPLATE_SHEET_NAME);
    ws.columns = EXCEL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.addRow({
      projectCode: (await prisma.project.findUnique({ where: { id: projectId } }))!.code,
      budgetYear: 2026,
      subjectCode: '101',
      amount: 55,
      businessDate: '2026-08-08',
      handler: '辛',
      summary: '标准模板一行',
      businessStatus: '已支出',
    });
    const buf = await wb.xlsx.writeBuffer();
    const batchId = await parseAndValidate(
      Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
      projectId,
      adminUser(),
      'std.xlsx',
    );
    const preview = await getSettlementBatch(batchId, adminUser()).catch((e: unknown) => {
      expect((e as { status?: number }).status).toBe(409);
      return null;
    });
    // 结算单预览接口对标准模板批次拒绝(路由层已分流;此处防御性校验)。
    expect(preview).toBeNull();
  });
});
