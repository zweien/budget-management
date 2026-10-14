import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { SETTLEMENT_V3_TEMPLATE_VERSION } from '@/lib/excel/settlement';
import {
  loadSettlementWorkbookIfMatch,
  parseSettlement,
  getSettlementBatch,
  confirmSettlementImport,
} from '@/server/services/settlementImport.service';

/**
 * 财务结算单 v3(2025 导出,明细分组合并)集成测试:直连真实 PG(:5434)。
 * 表头含 科研项目名称+开支细项名称 → 判 v3;同号多行(含负数冲账行)按单据编号
 * 分组、金额取组内代数和;开支细项末段==叶科目名时自动预选科目。
 */

/** 与真实导出一致的 20 列布局。 */
const V3_HEADERS = [
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
  '合同编号',
  '科研项目名称',
  '开支细项名称',
  '预算科目代码',
  '摘要',
  '经费明细部门名称',
];

interface V3RowData {
  docNo?: string;
  docStatus?: string;
  applyDate?: string;
  completeDate?: string;
  amount?: number | string;
  handler?: string;
  remark?: string;
  detailPath?: string;
  finCode?: string;
  projectName?: string;
  summary?: string;
}

async function buildV3Xlsx(rows: V3RowData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(V3_HEADERS);
  for (const r of rows) {
    ws.addRow([
      r.docNo ?? '',
      r.docStatus ?? '完成记账',
      '',
      '计算机系',
      '通用报销',
      '差旅费',
      r.applyDate ?? '',
      r.completeDate ?? '',
      '无人系统总体技术研究室',
      r.handler ?? '',
      r.amount ?? '',
      '',
      r.remark ?? '',
      '',
      '',
      r.projectName ?? '其他专项科学技术费/完全无关的另一个项目',
      r.detailPath ?? '',
      r.finCode ?? '',
      r.summary ?? '',
      '计算机系',
    ]);
  }
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

describe('settlementImport v3 (2025 财务导出,明细分组合并)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let projectId = '';
  let leafTravelId = ''; // 叶科目名「差旅费」(开支细项末段可命中)
  let leafTrafficId = ''; // 叶科目名「市内交通费」
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({ data: { id: adminId, name: 'admin-v3', role: UserRole.ADMIN } });
    createdUserIds.push(adminId);

    const project = await createProject(
      { code: `V3-${uuidv7().slice(0, 8)}`, name: '知识资源图谱驱动测试项目' },
      adminUser(),
    );
    projectId = project.id;
    createdProjectIds.push(project.id);
    // 科目树:根 → 两叶(差旅费/市内交通费),叶名与真实开支细项末段一致。
    const root = await prisma.budgetSubject.create({
      data: {
        id: uuidv7(),
        projectId,
        code: 'ROOT',
        name: '直接费用',
        level: 1,
        isLeaf: false,
      },
    });
    leafTravelId = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: leafTravelId,
        projectId,
        parentId: root.id,
        code: 'L1',
        name: '差旅费',
        level: 2,
        isLeaf: true,
      },
    });
    leafTrafficId = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: leafTrafficId,
        projectId,
        parentId: root.id,
        code: 'L2',
        name: '市内交通费',
        level: 2,
        isLeaf: true,
      },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('v3:同号冲账重报合并为净额一条;开支细项末段自动预选科目;项目名不符标记', async () => {
    const buf = await buildV3Xlsx([
      // 同号 3 行:-15000 冲销 + 15000 + 15000 → 净额 15000,开支细项末段=差旅费(预选)。
      {
        docNo: 'TYBX-MERGE-1',
        applyDate: '2025-02-17',
        completeDate: '2025-02-28',
        amount: -15000,
        handler: '李昱',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        finCode: '1891953874YJ2500F1',
        remark: '冲销行',
      },
      {
        docNo: 'TYBX-MERGE-1',
        applyDate: '2025-02-17',
        completeDate: '2025-02-28',
        amount: 15000,
        handler: '李昱',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        finCode: '1891953874YJ2500F1',
        remark: '重报行',
      },
      {
        docNo: 'TYBX-MERGE-1',
        applyDate: '2025-02-17',
        completeDate: '2025-02-28',
        amount: 15000,
        handler: '李昱',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        finCode: '1891953874YJ2500F1',
      },
      // 净额为正的普通单行:末段=市内交通费(预选)。
      {
        docNo: 'TYBX-SINGLE-1',
        applyDate: '2025-12-19',
        completeDate: '2025-12-23',
        amount: 68.5,
        handler: '刘旭',
        detailPath: '直接费用/其他支出/市内交通费',
        finCode: '1891953874BR24002V',
        remark: '市内交通报销',
      },
      // 纯冲账组:净额 -3741.82 → 整组跳过。
      {
        docNo: 'TYBX-REVERSE-1',
        applyDate: '2025-03-04',
        amount: -3741.82,
        handler: '张小亚',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
      },
    ]);

    const wb = await loadSettlementWorkbookIfMatch(buf);
    expect(wb).not.toBeNull();
    const batchId = await parseSettlement(wb!, projectId, adminUser(), '2025.xlsx');
    const preview = await getSettlementBatch(batchId, adminUser());

    expect(preview.templateVersion).toBe(SETTLEMENT_V3_TEMPLATE_VERSION);
    // 合并组 + 单行组进 pending(2 条);纯冲账组 skipped(1)。
    expect(preview.pending).toHaveLength(2);
    expect(preview.skippedCount).toBe(1);
    expect(Object.keys(preview.skippedReasons)[0]).toContain('冲账');

    const merged = preview.pending.find((r) => r.parsedData.docNo === 'TYBX-MERGE-1')!;
    expect(merged).toBeTruthy();
    expect(merged.parsedData.amount).toBe('15000.00'); // 代数和 = 净额
    expect(merged.normalizedAmount).toBe('15000.00');
    expect(merged.parsedData.sourceRows).toHaveLength(3);
    expect(merged.parsedData.summary).toBe('冲销行'); // 组内第一个非空备注
    expect(merged.parsedData.status).toBe('PAID');
    expect(merged.parsedData.businessDate).toBe('2025-02-17');
    expect(merged.parsedData.completedDate).toBe('2025-02-28');
    // 科目自动预选:开支细项末段「差旅费」== 叶科目名。
    expect(merged.parsedData.subjectId).toBe(leafTravelId);
    // 项目名不符(文件名不含本项目名)→ 非阻断标记。
    expect(merged.parsedData.fileProjectMismatch).toBe(true);

    const single = preview.pending.find((r) => r.parsedData.docNo === 'TYBX-SINGLE-1')!;
    expect(single.parsedData.amount).toBe('68.50');
    expect(single.parsedData.subjectId).toBe(leafTrafficId);

    const skipped = preview.errors; // skipped 行不出现在 pending/duplicates
    void skipped;
  });

  it('v3:组内经办人/开支细项不一致 → error;确认导入写净额记录', async () => {
    const buf = await buildV3Xlsx([
      {
        docNo: 'TYBX-MIX-1',
        applyDate: '2025-05-06',
        amount: 100,
        handler: '张三',
        detailPath: '直接费用/其他支出/市内交通费',
        remark: '第一行',
      },
      {
        docNo: 'TYBX-MIX-1',
        applyDate: '2025-05-06',
        amount: 200,
        handler: '李四',
        detailPath: '直接费用/其他支出/市内交通费',
        remark: '第二行',
      },
      // 可确认行:预选科目差旅费,净额一行。
      {
        docNo: 'TYBX-OK-1',
        applyDate: '2025-06-01',
        completeDate: '2025-06-09',
        amount: 300,
        handler: '王五',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        remark: '差旅报销',
        projectName: '其他专项科学技术费/知识资源图谱驱动测试项目',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(wb!, projectId, adminUser(), 'mix.xlsx');
    const preview = await getSettlementBatch(batchId, adminUser());

    const mixed = preview.errors.find((r) => r.parsedData.docNo === 'TYBX-MIX-1');
    expect(mixed).toBeTruthy();
    expect(mixed!.errors.some((e) => e.message.includes('经办人不一致'))).toBe(true);
    expect(mixed!.parsedData.amount).toBe('300.00'); // 100+200 净额(尽管标错)

    // 确认:仅选可导入行(预选科目差旅费)。
    const okRow = preview.pending.find((r) => r.parsedData.docNo === 'TYBX-OK-1')!;
    expect(okRow.parsedData.subjectId).toBe(leafTravelId);
    expect(okRow.parsedData.fileProjectMismatch).toBe(false); // 文件项目名包含本项目名
    const result = await confirmSettlementImport(batchId, [okRow.rowId], {
      id: adminId,
      role: UserRole.ADMIN,
    });
    expect(result.created).toBe(1);

    const rec = await prisma.businessRecord.findFirst({
      where: { projectId, docNo: 'TYBX-OK-1' },
    });
    expect(rec).not.toBeNull();
    expect(rec!.amount.toFixed(2)).toBe('300.00');
    expect(rec!.status).toBe('PAID');
    expect(rec!.subjectId).toBe(leafTravelId);
  });
});
