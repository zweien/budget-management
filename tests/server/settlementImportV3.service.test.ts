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
  updateSettlementRows,
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
      r.projectName ?? '其他专项科学技术费/图谱驱动测试专属项目甲',
      r.detailPath ?? '',
      r.finCode ?? '',
      r.summary ?? '',
      '计算机系',
    ]);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/** 预览载荷的映射候选数。 */
const mappableCount = (p: { mappableProjects?: Array<unknown> }): number =>
  p.mappableProjects?.length ?? 0;

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
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
  let projectIdB = '';
  let leafTravelId = ''; // 叶科目名「差旅费」(开支细项末段可命中)
  let leafTrafficId = ''; // 叶科目名「市内交通费」
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({ data: { id: adminId, name: 'admin-v3', role: UserRole.ADMIN } });
    createdUserIds.push(adminId);

    const project = await createProject(
      {
        code: `V3-${uuidv7().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
        name: '图谱驱动测试专属项目甲',
      },
      adminUser(),
    );
    projectId = project.id;
    createdProjectIds.push(project.id);
    await prisma.initialBudgetApplication
      .create({
        data: {
          id: uuidv7(),
          projectId: project.id,
          status: 'APPROVED',
          applicantId: adminId,
          approvedAt: new Date(),
        },
      })
      .catch(() => {});
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
    // 项目自动预映射:文件项目名(去前缀)包含本项目名 → 自动落映射。
    expect(merged.parsedData.targetProjectId).toBe(projectId);

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
        projectName: '其他专项科学技术费/图谱驱动测试专属项目甲',
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
    expect(okRow.parsedData.targetProjectId).toBe(projectId); // 自动预映射命中本项目
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

  it('v3 多项目:自动预映射双项目;未命中留人工;确认分别入账到各自项目', async () => {
    // 第二个目标项目(文件里另一个「科研项目名称」)。
    const projectB = await createProject(
      {
        code: `V3-${uuidv7().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
        name: '另一个科研项目B',
      },
      adminUser(),
    );
    projectIdB = projectB.id;
    createdProjectIds.push(projectB.id);
    await prisma.initialBudgetApplication
      .create({
        data: {
          id: uuidv7(),
          projectId: projectB.id,
          status: 'APPROVED',
          applicantId: adminId,
          approvedAt: new Date(),
        },
      })
      .catch(() => {});
    const rootB = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: rootB,
        projectId: projectB.id,
        code: 'ROOT',
        name: '直接费用',
        level: 1,
        isLeaf: false,
      },
    });
    await prisma.budgetSubject.create({
      data: {
        id: uuidv7(),
        projectId: projectB.id,
        parentId: rootB,
        code: 'B1',
        name: '专家咨询费',
        level: 2,
        isLeaf: true,
      },
    });

    // 单文件含两个科研项目名称:
    // - 名称A 去前缀后包含本项目名 → 自动预映射到 project;
    // - 名称B 是「无法识别的项目」→ 未命中,留人工。
    const buf = await buildV3Xlsx([
      {
        docNo: 'TYBX-MP-A',
        applyDate: '2025-07-01',
        amount: 111,
        handler: '甲',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        remark: 'A项目行',
        projectName: '其他专项科学技术费/图谱驱动测试专属项目甲',
      },
      {
        docNo: 'TYBX-MP-B',
        applyDate: '2025-07-02',
        amount: 222,
        handler: '乙',
        detailPath: '直接费用/专家咨询费',
        remark: 'B项目行',
        projectName: '其他专项科学技术费/完全无关的另一个项目',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(wb!, projectId, adminUser(), 'multi.xlsx');
    let preview = await getSettlementBatch(batchId, adminUser());

    expect(preview.templateVersion).toBe(SETTLEMENT_V3_TEMPLATE_VERSION);
    expect(preview.projectMappings).toHaveLength(2);
    const mapA = preview.projectMappings.find((m) =>
      m.fileProjectName.includes('图谱驱动测试专属项目甲'),
    )!;
    const mapB = preview.projectMappings.find((m) => m.fileProjectName.includes('完全无关'))!;
    expect(mapA.targetProjectId).toBe(projectId); // 自动预映射命中
    expect(mapB.targetProjectId).toBeNull(); // 未命中 → 人工
    expect(mappableCount(preview)).toBeGreaterThanOrEqual(2);

    // 未映射行:留在 pending 但 error 态「未映射项目」?—— 服务端归 errors 组。
    const unmapped = preview.errors.find((r) => r.parsedData.docNo === 'TYBX-MP-B');
    expect(unmapped).toBeTruthy();
    expect(unmapped!.errors.some((e) => e.message.includes('未映射项目'))).toBe(true);

    // 确认被阻断(有 error 行未选中也不影响;仅选已映射行)。
    const rowA = preview.pending.find((r) => r.parsedData.docNo === 'TYBX-MP-A')!;
    expect(rowA.parsedData.targetProjectId).toBe(projectId);
    expect(rowA.parsedData.subjectId).toBe(leafTravelId); // 按目标项目预选

    // 人工映射:B → projectB(PATCH targetProjectId → 重算科目预选+查重)。
    await updateSettlementRows(
      batchId,
      [{ rowId: unmapped!.rowId, targetProjectId: projectB.id }],
      adminUser(),
    );
    preview = await getSettlementBatch(batchId, adminUser());
    const rowB = preview.pending.find((r) => r.parsedData.docNo === 'TYBX-MP-B')!;
    expect(rowB.parsedData.targetProjectId).toBe(projectB.id);
    // 按新目标项目重跑科目预选:细项末段「专家咨询费」== projectB 的叶科目名。
    expect(rowB.parsedData.subjectId).not.toBeNull();

    // 确认:两行分别入账到各自项目。
    const result = await confirmSettlementImport(batchId, [rowA.rowId, rowB.rowId], {
      id: adminId,
      role: UserRole.ADMIN,
    });
    expect(result.created).toBe(2);
    const recA = await prisma.businessRecord.findFirst({
      where: { projectId, docNo: 'TYBX-MP-A' },
    });
    const recB = await prisma.businessRecord.findFirst({
      where: { projectId: projectB.id, docNo: 'TYBX-MP-B' },
    });
    expect(recA).not.toBeNull();
    expect(recB).not.toBeNull();
  });

  it('v3:同号跨项目拆组/各目标叶科目清单/整组无日期报错/Key 范围过滤候选', async () => {
    const projectBName = '另一个科研项目B';
    const projectB = await createProject(
      {
        code: `V3-${uuidv7().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
        name: projectBName,
      },
      adminUser(),
    );
    projectIdB = projectB.id;
    createdProjectIds.push(projectB.id);
    await prisma.initialBudgetApplication
      .create({
        data: {
          id: uuidv7(),
          projectId: projectB.id,
          status: 'APPROVED',
          applicantId: adminId,
          approvedAt: new Date(),
        },
      })
      .catch(() => {});
    const rootB = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: rootB,
        projectId: projectB.id,
        code: 'ROOT',
        name: '直接费用',
        level: 1,
        isLeaf: false,
      },
    });
    await prisma.budgetSubject.create({
      data: {
        id: uuidv7(),
        projectId: projectB.id,
        parentId: rootB,
        code: 'B1',
        name: '专家咨询费',
        level: 2,
        isLeaf: true,
      },
    });
    // 1) 同单据编号出现在两个科研项目名称下 → 分组按 项目+单据 拆分,各自入账。
    const buf2 = await buildV3Xlsx([
      {
        docNo: 'TYBX-SHARED-1',
        applyDate: '2025-09-01',
        amount: 500,
        handler: '甲',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        remark: 'A 侧明细',
        projectName: '其他专项科学技术费/图谱驱动测试专属项目甲',
      },
      {
        docNo: 'TYBX-SHARED-1',
        applyDate: '2025-09-02',
        amount: 700,
        handler: '乙',
        detailPath: '直接费用/专家咨询费',
        remark: 'B 侧明细',
        projectName: `其他专项科学技术费/${projectBName}`,
      },
    ]);
    const wb2 = await loadSettlementWorkbookIfMatch(buf2);
    const batchId2 = await parseSettlement(wb2!, projectId, adminUser(), 'shared.xlsx');
    let preview2 = await getSettlementBatch(batchId2, adminUser());

    // 名称B 与任何项目都无名称关联 → 未映射留人工(同号行也不会与名称A 合并)。
    const rowB0 = preview2.errors.find((r) => r.parsedData.docNo === 'TYBX-SHARED-1')!;
    expect(rowB0.errors.some((e) => e.message.includes('未映射项目'))).toBe(true);
    const rowA = preview2.pending.find(
      (r) => r.parsedData.docNo === 'TYBX-SHARED-1' && r.parsedData.amount === '500.00',
    )!;
    expect(rowA.parsedData.targetProjectId).toBe(projectId);

    // 人工映射:名称B → projectB(重算科目预选 + 按目标查重)。
    await updateSettlementRows(
      batchId2,
      [{ rowId: rowB0.rowId, targetProjectId: projectB.id }],
      adminUser(),
    );
    preview2 = await getSettlementBatch(batchId2, adminUser());
    const sharedRows = preview2.pending.filter((r) => r.parsedData.docNo === 'TYBX-SHARED-1');
    expect(sharedRows).toHaveLength(2);
    const sharedA = sharedRows.find((r) => r.parsedData.targetProjectId === projectId)!;
    const sharedB = sharedRows.find((r) => r.parsedData.targetProjectId === projectB.id)!;
    expect(sharedA.parsedData.amount).toBe('500.00');
    expect(sharedB.parsedData.amount).toBe('700.00');
    // 各目标项目的叶科目清单(行级下拉按行目标取用)。
    expect(preview2.leafSubjectsByProject?.[projectId]?.some((s) => s.name === '差旅费')).toBe(
      true,
    );
    expect(
      preview2.leafSubjectsByProject?.[projectB.id]?.some((s) => s.name === '专家咨询费'),
    ).toBe(true);
    const result2 = await confirmSettlementImport(batchId2, [sharedA.rowId, sharedB.rowId], {
      id: adminId,
      role: UserRole.ADMIN,
    });
    expect(result2.created).toBe(2);
    expect(
      (await prisma.businessRecord.findFirst({
        where: { projectId, docNo: 'TYBX-SHARED-1' },
      }))!.amount.toFixed(2),
    ).toBe('500.00');
    expect(
      (await prisma.businessRecord.findFirst({
        where: { projectId: projectB.id, docNo: 'TYBX-SHARED-1' },
      }))!.amount.toFixed(2),
    ).toBe('700.00');

    // 2) 整组无申请日期 → 预览期即 error(而不是拖到确认期整体失败)。
    const buf3 = await buildV3Xlsx([
      {
        docNo: 'TYBX-NODATE',
        amount: 10,
        handler: '丁',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        remark: '无日期行',
        projectName: '其他专项科学技术费/图谱驱动测试专属项目甲',
      },
    ]);
    const wb3 = await loadSettlementWorkbookIfMatch(buf3);
    const batchId3 = await parseSettlement(wb3!, projectId, adminUser(), 'nodate.xlsx');
    const preview3 = await getSettlementBatch(batchId3, adminUser());
    const errRow = preview3.errors.find((r) => r.parsedData.docNo === 'TYBX-NODATE');
    expect(errRow).toBeTruthy();
    expect(errRow!.errors.some((e) => e.message.includes('申请日期不能为空'))).toBe(true);

    // 3) 机器凭证 selected 项目范围:映射候选仅含允许清单内的项目(codex P2)。
    const scopedUser = {
      id: adminId,
      role: UserRole.ADMIN,
      viaApiKey: true,
      keyProjectScope: 'selected',
      keyProjectIds: [projectId],
    };
    const scopedBatch = await parseSettlement(wb3!, projectId, scopedUser, 'scoped.xlsx');
    const scopedPreview = await getSettlementBatch(scopedBatch, scopedUser);
    const names = scopedPreview.mappableProjects.map((p) => p.name);
    expect(names).toContain('图谱驱动测试专属项目甲');
    expect(names).not.toContain(projectBName);
  });

  it('v3 多项目权限:映射无导入权限的目标项目 → 403', async () => {
    // 普通用户:是本项目 HANDLER(可导入本项目),但不是项目 B 成员。
    const userId = uuidv7();
    await prisma.user.create({ data: { id: userId, name: 'v3-handler', role: UserRole.USER } });
    createdUserIds.push(userId);
    await prisma.projectMember.create({
      data: {
        id: uuidv7(),
        projectId,
        userId,
        memberRole: 'OWNER',
      },
    });
    const buf = await buildV3Xlsx([
      {
        docNo: 'TYBX-PERM-1',
        applyDate: '2025-08-01',
        amount: 10,
        handler: '丙',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        remark: '权限行',
        projectName: '其他专项科学技术费/完全无关的另一个项目',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(
      wb!,
      projectId,
      { id: userId, role: UserRole.USER },
      'perm.xlsx',
    );
    const preview = await getSettlementBatch(batchId, { id: userId, role: UserRole.USER });
    // 候选仅含其可导入项目;文件项目名未命中 → 未映射 error。
    const unmapped = preview.errors.find((r) => r.parsedData.docNo === 'TYBX-PERM-1');
    expect(unmapped).toBeTruthy();
    // 人工映射到无权限的项目(projectIdB)→ 403。
    await expect(
      updateSettlementRows(batchId, [{ rowId: unmapped!.rowId, targetProjectId: projectIdB }], {
        id: userId,
        role: UserRole.USER,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('v3 门禁:目标项目初始预算未审批 → 行级 error;已审批目标行正常', async () => {
    // 第二个项目:从未审批(无编制单),名称可被文件命中自动预映射。
    const projectB = await createProject(
      {
        code: `V3-${uuidv7().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
        name: '门禁未审批项目B',
      },
      adminUser(),
    );
    projectIdB = projectB.id;
    createdProjectIds.push(projectB.id);
    await prisma.budgetSubject.create({
      data: {
        id: uuidv7(),
        projectId: projectB.id,
        parentId: null,
        code: 'G1',
        name: '专家咨询费',
        level: 1,
        isLeaf: true,
      },
    });

    const buf = await buildV3Xlsx([
      {
        docNo: 'GATE-A',
        applyDate: '2025-08-01',
        amount: 100,
        handler: '甲',
        detailPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        remark: 'A项目行',
        projectName: '其他专项科学技术费/图谱驱动测试专属项目甲',
      },
      {
        docNo: 'GATE-B',
        applyDate: '2025-08-02',
        amount: 200,
        handler: '乙',
        detailPath: '直接费用/专家咨询费',
        remark: 'B项目行',
        projectName: '其他专项科学技术费/门禁未审批项目B',
      },
    ]);
    const wb = await loadSettlementWorkbookIfMatch(buf);
    const batchId = await parseSettlement(wb!, projectId, adminUser(), 'gate.xlsx');
    const preview = await getSettlementBatch(batchId, adminUser());

    // 已审批目标(甲) → pending 正常;未审批目标(B) → 行级 error。
    const rowA = preview.pending.find((r) => r.parsedData.docNo === 'GATE-A');
    const rowB = preview.errors.find((r) => r.parsedData.docNo === 'GATE-B');
    expect(rowA).toBeTruthy();
    expect(rowB).toBeTruthy();
    expect(rowB!.errors.some((e) => e.message.includes('初始预算尚未审批通过'))).toBe(true);
    // 映射已自动命中 B(只是被门禁拦下),预览可改映射到已审批项目。
    expect(
      preview.projectMappings.find((m) => m.fileProjectName.includes('门禁未审批'))!
        .targetProjectId,
    ).toBe(projectB.id);

    // 确认侧防御:把 A 行改映射到未审批的 B → 确认 422 并点名项目。
    await updateSettlementRows(
      batchId,
      [{ rowId: rowA!.rowId, targetProjectId: projectB.id }],
      adminUser(),
    );
    await expect(
      confirmSettlementImport(batchId, [rowA!.rowId], adminUser()),
    ).rejects.toMatchObject({
      status: 422,
    });
    // 改回已审批目标 → 确认成功(不受 B 的 error 行影响)。
    await updateSettlementRows(
      batchId,
      [{ rowId: rowA!.rowId, targetProjectId: projectId }],
      adminUser(),
    );
    const res = await confirmSettlementImport(batchId, [rowA!.rowId], adminUser());
    expect(res.created).toBe(1);
  });
});
