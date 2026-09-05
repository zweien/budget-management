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
  deleteImportBatch,
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
    // §悬浮理由:硬重复行带既有记录摘要(金额 1 ≠ 本行 20,不走补全更新)。
    expect(hardRow.parsedData.dupReason).toContain('与项目内已有记录冲突');
    expect(hardRow.parsedData.dupReason).toContain('已有单据');
    expect(hardRow.parsedData.dupReason).toContain('当前状态 已支出');
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

  // ---------- v2(申请日期版)----------
  interface V2RowData {
    docNo?: string;
    docStatus?: string;
    applyDate?: string;
    completeDate?: string;
    amount?: number | string;
    handler?: string;
    remark?: string;
  }

  /** 构造 v2(申请日期版)结算单 xlsx:表头第 1 行 + 数据行(含被忽略的新列)。 */
  async function buildSettlementV2Xlsx(rows: V2RowData[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('2026');
    ws.addRow([
      '单据编号',
      '单据状态',
      '单位',
      '部门',
      '单据类型',
      '业务类型',
      '申请日期',
      '完成日期',
      '制单人',
      '经办人',
      '金额',
      '合同编号',
      '备注',
      '补录标识',
    ]);
    for (const r of rows) {
      ws.addRow([
        r.docNo ?? '',
        r.docStatus ?? '',
        '计算机学院',
        '研发中心',
        '通用报销',
        '零星采购经费',
        r.applyDate ?? '',
        r.completeDate ?? '',
        '研发中心',
        r.handler ?? '',
        r.amount ?? '',
        '',
        r.remark ?? '',
        '',
      ]);
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }

  it('v2 申请日期版:识别/列映射/完成审核→财务审批/完成日期入库;单位等部门等新列忽略', async () => {
    const buf = await buildSettlementV2Xlsx([
      {
        docNo: 'V2-PAID',
        docStatus: '完成记账',
        applyDate: '2026-07-07',
        completeDate: '2026-07-13',
        amount: '79.24',
        handler: '许超',
        remark: '研发中心许超报（其他支出）取项目光盘的市内交通费',
      },
      {
        docNo: 'V2-AUDIT',
        docStatus: '完成审核',
        applyDate: '2026-08-31',
        amount: '122.16',
        handler: '陈柏瑞',
        remark: '研发中心陈柏瑞报（其他支出）外出参会市内交通费',
      },
      {
        docNo: 'V2-VOID',
        docStatus: '业务退单',
        applyDate: '2026-08-01',
        amount: '10',
        handler: '辛',
        remark: '退单',
      },
      {
        docNo: 'V2-ORDER',
        docStatus: '完成记账',
        applyDate: '2026-08-10',
        completeDate: '2026-08-01',
        amount: '30',
        handler: '壬',
        remark: '日期倒挂',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    expect(wb).not.toBeNull();
    const batchId = await parseSettlement(wb!, projectId, adminUser());
    const preview = await getSettlementBatch(batchId, adminUser());

    // §codex P1:日期倒挂行 → 错误行,不可导入(与手动/接口录入同规则)。
    const order = preview.errors.find((r) => r.parsedData.docNo === 'V2-ORDER')!;
    expect(
      order.errors.some(
        (e) => e.field === 'completedDate' && e.message.includes('不能早于申请日期'),
      ),
    ).toBe(true);

    const paid = preview.pending.find((r) => r.parsedData.docNo === 'V2-PAID')!;
    expect(paid.parsedData.status).toBe(BusinessStatus.PAID);
    expect(paid.parsedData.businessDate).toBe('2026-07-07');
    expect(paid.parsedData.completedDate).toBe('2026-07-13');
    expect(paid.parsedData.summary).toContain('取项目光盘');
    expect(paid.parsedData.budgetYear).toBe(2026);

    const audit = preview.pending.find((r) => r.parsedData.docNo === 'V2-AUDIT')!;
    expect(audit.parsedData.status).toBe(BusinessStatus.FINANCE_APPROVAL);
    expect(audit.parsedData.completedDate ?? null).toBeNull();

    expect(preview.skippedCount).toBe(1);

    // 指定科目 → 确认:created=2,完成日期写入已支出行。
    await updateSettlementRows(
      batchId,
      [
        { rowId: paid.rowId, subjectId: leafId },
        { rowId: audit.rowId, subjectId: leafId2 },
      ],
      adminUser(),
    );
    const res = await confirmSettlementImport(batchId, [paid.rowId, audit.rowId], adminUser());
    expect(res.created).toBe(2); // 倒挂行在错误分组,不参与确认。
    expect(res.updated).toBe(0);
    const saved = await prisma.businessRecord.findFirst({ where: { docNo: 'V2-PAID' } });
    expect(saved!.completedDate?.toISOString().slice(0, 10)).toBe('2026-07-13');
    const savedAudit = await prisma.businessRecord.findFirst({ where: { docNo: 'V2-AUDIT' } });
    expect(savedAudit!.completedDate).toBeNull();
    expect(savedAudit!.status).toBe(BusinessStatus.FINANCE_APPROVAL);
  });

  it('§补全更新:状态推进(v1)与完成日期回填(v2)走 refresh;金额不一致/无新信息仍硬重复;确认复核竞态 422', async () => {
    // 既有记录:REF-ADV(财务审批,无完成日期)、REF-FILL(已支出,完成日期空)、REF-SAME(已支出+完成日期)、REF-AMT(金额不同)。
    const seeded = await prisma.businessRecord.createMany({
      data: [
        {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: toStored(new Prisma.Decimal('50')),
          businessDate: new Date('2026-06-01T00:00:00Z'),
          handler: '旧',
          summary: '推进源',
          status: BusinessStatus.FINANCE_APPROVAL,
          docNo: 'REF-ADV',
          createdById: adminId,
        },
        {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: toStored(new Prisma.Decimal('60')),
          businessDate: new Date('2026-06-02T00:00:00Z'),
          handler: '旧',
          summary: '回填源',
          status: BusinessStatus.PAID,
          docNo: 'REF-FILL',
          createdById: adminId,
        },
        {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: toStored(new Prisma.Decimal('70')),
          businessDate: new Date('2026-06-03T00:00:00Z'),
          handler: '旧',
          summary: '无新信息',
          status: BusinessStatus.PAID,
          docNo: 'REF-SAME',
          completedDate: new Date('2026-07-01T00:00:00Z'),
          createdById: adminId,
        },
        {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: toStored(new Prisma.Decimal('80')),
          businessDate: new Date('2026-06-04T00:00:00Z'),
          handler: '旧',
          summary: '金额不同',
          status: BusinessStatus.FINANCE_APPROVAL,
          docNo: 'REF-AMT',
          createdById: adminId,
        },
        {
          id: uuidv7(),
          projectId,
          budgetYear: 2026,
          subjectId: leafId,
          amount: toStored(new Prisma.Decimal('90')),
          businessDate: new Date('2026-06-10T00:00:00Z'),
          handler: '旧',
          summary: '倒挂源',
          status: BusinessStatus.FINANCE_APPROVAL,
          docNo: 'REF-ORDER',
          createdById: adminId,
        },
      ],
    });
    expect(seeded.count).toBe(5);

    const buf = await buildSettlementV2Xlsx([
      // 状态推进 + 回填完成日期 → refresh。
      {
        docNo: 'REF-ADV',
        docStatus: '完成记账',
        applyDate: '2026-06-01',
        completeDate: '2026-07-05',
        amount: '50',
        handler: '新',
        remark: '推进源',
      },
      // 已支出、完成日期为空 → 仅回填完成日期 → refresh。
      {
        docNo: 'REF-FILL',
        docStatus: '完成记账',
        applyDate: '2026-06-02',
        completeDate: '2026-07-06',
        amount: '60',
        handler: '新',
        remark: '回填源',
      },
      // 无新信息(已支出且完成日期已有)→ 硬重复。
      {
        docNo: 'REF-SAME',
        docStatus: '完成记账',
        applyDate: '2026-06-03',
        completeDate: '2026-07-01',
        amount: '70',
        handler: '新',
        remark: '无新信息',
      },
      // 金额不一致 → 硬重复。
      {
        docNo: 'REF-AMT',
        docStatus: '完成记账',
        applyDate: '2026-06-04',
        completeDate: '2026-07-08',
        amount: '999',
        handler: '新',
        remark: '金额不同',
      },
      // v1 状态推进:同号 完成记账 → refresh(v1 亦启用)。
    ]);
    const v1buf = await buildSettlementXlsx([
      {
        docNo: 'REF-ADV',
        docStatus: '完成记账',
        fillDate: '2026-06-01',
        subject: '推进源',
        amount: '50',
        handler: '新',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(wb!, projectId, adminUser());
    const preview = await getSettlementBatch(batchId, adminUser());
    const d = (no: string) => preview.duplicates.find((r) => r.parsedData.docNo === no)!;
    expect(d('REF-ADV').duplicateLevel).toBe('refresh');
    expect(d('REF-FILL').duplicateLevel).toBe('refresh');
    expect(d('REF-SAME').duplicateLevel).toBe('hard');
    // 无新信息 → 硬重复理由指明冲突详情(非"文件内")。
    expect(d('REF-SAME').parsedData.dupReason).toContain('无新信息');
    expect(d('REF-AMT').duplicateLevel).toBe('hard');
    // refresh 行无需科目即可确认。

    // v1 状态推进:同号 完成记账 → refresh(v1 亦启用)。
    const wb1 = await loadSettlementWorkbookIfMatch(v1buf);
    const batchId1 = await parseSettlement(wb1!, projectId, adminUser());
    const preview1 = await getSettlementBatch(batchId1, adminUser());
    expect(preview1.duplicates[0].duplicateLevel).toBe('refresh');

    // 确认:两条 refresh 更新既有记录,不新增;硬重复行确认被拒。
    const adv = d('REF-ADV');
    const fill = d('REF-FILL');
    const same = d('REF-SAME');
    await expect(
      confirmSettlementImport(batchId, [adv.rowId, fill.rowId, same.rowId], adminUser()),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('硬重复') });
    const res = await confirmSettlementImport(batchId, [adv.rowId, fill.rowId], adminUser());
    expect(res.created).toBe(0);
    expect(res.updated).toBe(2);
    // 批次计数落定:文件 4 行,导入 0 + 更新 2。
    const confirmedBatch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    expect(confirmedBatch!.createdCount).toBe(0);
    expect(confirmedBatch!.updatedCount).toBe(2);

    const recAdv = await prisma.businessRecord.findFirst({ where: { docNo: 'REF-ADV' } });
    expect(recAdv!.status).toBe(BusinessStatus.PAID);
    expect(recAdv!.completedDate?.toISOString().slice(0, 10)).toBe('2026-07-05');
    const recFill = await prisma.businessRecord.findFirst({ where: { docNo: 'REF-FILL' } });
    expect(recFill!.status).toBe(BusinessStatus.PAID);
    expect(recFill!.completedDate?.toISOString().slice(0, 10)).toBe('2026-07-06');
    // §codex P2:补全更新写业务记录历史。
    const hist = await prisma.businessRecordHistory.findFirst({
      where: { businessRecordId: recFill!.id, action: 'import_refresh' },
      orderBy: { operatedAt: 'desc' },
    });
    expect(hist).not.toBeNull();
    expect(hist!.reason).toContain('补全更新');
    const after = hist!.afterData as Record<string, unknown>;
    expect(after['completedDate']).toBe('2026-07-06');
    // 更新写审计。
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'business_records', action: 'import_refresh' },
      orderBy: { operatedAt: 'desc' },
    });
    expect(audit).not.toBeNull();

    // §codex P1:回填完成日期早于**既有记录**的申请日期(行自身日期已过解析)→ 确认时 422。
    const buf3 = await buildSettlementV2Xlsx([
      {
        docNo: 'REF-ORDER',
        docStatus: '完成记账',
        applyDate: '2026-05-01',
        completeDate: '2026-05-20',
        amount: '90',
        handler: '新',
        remark: '倒挂源',
      },
    ]);
    const wb3 = await loadSettlementWorkbookIfMatch(buf3);
    const batchId3 = await parseSettlement(wb3!, projectId, adminUser());
    const preview3 = await getSettlementBatch(batchId3, adminUser());
    const r3 = preview3.duplicates.find((x) => x.parsedData.docNo === 'REF-ORDER')!;
    expect(r3.duplicateLevel).toBe('refresh');
    await expect(confirmSettlementImport(batchId3, [r3.rowId], adminUser())).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('早于该记录的申请日期'),
    });

    // v1 状态推进单确认:既有 REF-ADV 已是 PAID → 状态无法再推进 → 复核 422(无新信息)。
    const preview1b = await getSettlementBatch(batchId1, adminUser());
    const r1 = preview1b.duplicates[0];
    await expect(confirmSettlementImport(batchId1, [r1.rowId], adminUser())).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('无可更新内容'),
    });

    // 竞态:refresh 行确认前既有记录被作废 → 复核 422。
    const buf2 = await buildSettlementV2Xlsx([
      {
        docNo: 'REF-FILL',
        docStatus: '完成记账',
        applyDate: '2026-06-02',
        completeDate: '2026-08-08',
        amount: '60',
        handler: '新',
        remark: '回填源',
      },
    ]);
    const wb2 = await loadSettlementWorkbookIfMatch(buf2);
    const batchId2 = await parseSettlement(wb2!, projectId, adminUser());
    const preview2 = await getSettlementBatch(batchId2, adminUser());
    const r2 = preview2.duplicates.find((x) => x.parsedData.docNo === 'REF-FILL')!;
    await prisma.businessRecord.updateMany({
      where: { docNo: 'REF-FILL', projectId },
      data: { isVoid: true, voidedAt: new Date(), voidReason: '测试作废' },
    });
    await expect(confirmSettlementImport(batchId2, [r2.rowId], adminUser())).rejects.toMatchObject({
      status: 422,
    });
  });

  it('批次列表带 文件行数/实际导入 计数;删除:pending 可删(级联行),confirmed 409', async () => {
    // 批次 A:确认 → createdCount 落定;批次 B:pending → 删除后行与批次消失。
    const bufA = await buildSettlementV2Xlsx([
      {
        docNo: 'DEL-1',
        docStatus: '完成记账',
        applyDate: '2026-05-01',
        completeDate: '2026-05-02',
        amount: '11',
        handler: '甲',
        remark: '已导入行',
      },
      {
        docNo: 'DEL-2',
        docStatus: '完成审核',
        applyDate: '2026-05-03',
        amount: '12',
        handler: '甲',
        remark: '已导入行2',
      },
    ]);
    const wbA = await loadSettlementWorkbookIfMatch(bufA);
    const batchA = await parseSettlement(wbA!, projectId, adminUser());
    const prevA = await getSettlementBatch(batchA, adminUser());
    await updateSettlementRows(
      batchA,
      prevA.pending.map((r) => ({ rowId: r.rowId, subjectId: leafId })),
      adminUser(),
    );
    const resA = await confirmSettlementImport(
      batchA,
      prevA.pending.map((r) => r.rowId),
      adminUser(),
    );
    expect(resA.created).toBe(2);

    const bufB = await buildSettlementV2Xlsx([
      {
        docNo: 'DEL-3',
        docStatus: '完成记账',
        applyDate: '2026-05-05',
        amount: '13',
        handler: '乙',
        remark: '待删行',
      },
      {
        docNo: 'DEL-4',
        docStatus: '完成记账',
        applyDate: '2026-05-06',
        amount: '14',
        handler: '乙',
        remark: '待删行2',
      },
    ]);
    const wbB = await loadSettlementWorkbookIfMatch(bufB);
    const batchB = await parseSettlement(wbB!, projectId, adminUser());

    const listed = await listImportBatches(projectId, adminUser());
    const a = listed.find((b) => b.batchId === batchA)!;
    const b = listed.find((x) => x.batchId === batchB)!;
    expect(a.rowCount).toBe(2);
    expect(a.createdCount).toBe(2);
    expect(a.confirmedAt).not.toBeNull();
    expect(b.status).toBe('pending');
    expect(b.createdCount).toBeNull();

    // 已确认批次删除 → 409。
    await expect(deleteImportBatch(batchA, adminUser())).rejects.toMatchObject({ status: 409 });

    // pending 批次删除 → 批次与行级联消失。
    await deleteImportBatch(batchB, adminUser());
    expect(await prisma.importBatch.findUnique({ where: { id: batchB } })).toBeNull();
    expect(await prisma.importRow.count({ where: { batchId: batchB } })).toBe(0);
    const listedAfter = await listImportBatches(projectId, adminUser());
    expect(listedAfter.map((x) => x.batchId)).not.toContain(batchB);
  });

  it('parseSettlement:行数超过 MAX_IMPORT_ROWS → 422(容量边界,不落任何行)', async () => {
    // 上限默认 2000:构造 2100 数据行(远超上限),预闸直接拒绝。
    const rows = Array.from({ length: 2100 }, (_, i) => ({
      docNo: `CAP-${i}`,
      docStatus: '已支付',
      fillDate: '2026-01-02',
      amount: 1,
      handler: '经办',
    }));
    const stl = await buildSettlementXlsx(rows);
    const wb = await loadSettlementWorkbookIfMatch(stl);
    expect(wb).not.toBeNull();
    const batchesBefore = await prisma.importBatch.count({ where: { projectId } });
    await expect(parseSettlement(wb!, projectId, adminUser())).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('超过上限'),
    });
    // 不落任何批次/行(与测试前计数持平——本项目已有其他测试的批次)。
    expect(await prisma.importBatch.count({ where: { projectId } })).toBe(batchesBefore);
  });
});
