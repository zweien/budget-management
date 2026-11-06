import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { SETTLEMENT_V4_TEMPLATE_VERSION } from '@/lib/excel/settlement';
import {
  loadSettlementWorkbookIfMatch,
  parseSettlement,
  parseSettlementUnified,
  getSettlementBatch,
  confirmSettlementImport,
} from '@/server/services/settlementImport.service';

/**
 * 结算单 v4(单据台账,财务系统台账导出)集成测试:直连真实 PG(:5434)。
 * 表头含 单据ID+报销金额(元)+控制项 → 判 v4;单据粒度一行一单,净额 =
 * 报销金额 − 冲销金额(≤0 跳过);年度取「年度」列;控制项末段预选叶科目;
 * 项目列去口径前缀映射,与 v3 同管线(查重/补全更新/确认)。
 */

/** 与真实导出一致的 33 列布局(列序无关,按表头名匹配)。 */
const V4_HEADERS = [
  '单据编号',
  '单据ID',
  '年度',
  '单据类型',
  '单据状态',
  '经费类型',
  '报销金额(元)',
  '支付金额(元)',
  '冲销金额(元)',
  '经办人',
  '经办人电话',
  '摘要',
  '报销说明',
  '填报日期',
  '完成日期',
  '附件张数',
  '单位',
  '部门',
  '项目',
  '控制项',
  '经费科目',
  '支出分类',
  '合同编号',
  '密级',
  '审批状态',
  '收款人/账号/开户行',
  '创建人/时间',
  '最后修改人/时间',
  '流程实例',
  '影像页链接',
  '影像文件数',
  '影像文件名',
  '下载状态',
];

interface V4RowData {
  docNo?: string;
  year?: number | string;
  docStatus?: string;
  claim?: number | string;
  offset?: number | string;
  handler?: string;
  summary?: string;
  explain?: string;
  fillDate?: string;
  /** 支持真实导出的 ISO 时间戳形态(截日期部分)。 */
  completeDate?: string;
  project?: string;
  controlPath?: string;
  finSubject?: string;
}

async function buildV4Xlsx(rows: V4RowData[], headers: string[] = V4_HEADERS): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('单据台账');
  ws.addRow(headers);
  const fullRow = (r: V4RowData) => [
    r.docNo ?? '',
    uuidv7(),
    r.year ?? 2025,
    '通用报销',
    r.docStatus ?? '待记账',
    '差旅费',
    r.claim ?? 0,
    r.claim ?? 0,
    r.offset ?? 0,
    r.handler ?? '徐维乐',
    '17800000000',
    r.summary ?? '',
    r.explain ?? '',
    r.fillDate ?? '2025-11-25',
    r.completeDate ?? '',
    2,
    '计算机学院',
    '计算机系',
    r.project ?? '',
    r.controlPath ?? '',
    r.finSubject ?? '',
    '差旅费',
    '',
    'NB',
    'Approved',
    '',
    '',
    '',
    '',
    '',
    1,
    '',
    '',
  ];
  for (const r of rows) {
    const cells = fullRow(r);
    // 自定义表头(缺列/重复列用例):按表头数截齐,防错位。
    ws.addRow(headers.map((_, i) => cells[i] ?? ''));
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

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

describe('settlementImport v4 (单据台账,单据粒度净额)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let projectId = '';
  let leafTravelId = ''; // 叶科目名「差旅费」(控制项末段可命中)
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({ data: { id: adminId, name: 'admin-v4', role: UserRole.ADMIN } });
    createdUserIds.push(adminId);

    const project = await createProject(
      {
        code: `V4-${uuidv7().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
        name: '台账驱动测试专属项目甲',
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
    const root = await prisma.budgetSubject.create({
      data: { id: uuidv7(), projectId, code: 'ROOT', name: '直接费用', level: 1, isLeaf: false },
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
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('v4:净额=报销−冲销;年度取列值;ISO 完成日期截日期;控制项末段预选科目;跳过/错误形态', async () => {
    const buf = await buildV4Xlsx([
      // 普通行:待记账 → FINANCE_APPROVAL;净额 80;完成日期 ISO 时间戳 → 2025-11-28。
      {
        docNo: 'TZ-V4-1',
        year: 2025,
        docStatus: '待记账',
        claim: 80,
        offset: 0,
        handler: '徐维乐',
        summary: '（差旅费）参加研讨会的市内交通费',
        fillDate: '2025-11-25',
        completeDate: '2025-11-28T01:46:52.872+00:00',
        project: '科研试制费/台账驱动测试专属项目甲',
        controlPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        finSubject: '1891953874GN24003E',
      },
      // 完成记账 → PAID;部分冲销:500 − 200 = 300;跨年填报(年度 2024 ≠ 填报年份
      // 2025)→ 预算年度取「年度」列,防误从日期推导的回归(codex 评审 P2)。
      {
        docNo: 'TZ-V4-2',
        year: 2024,
        docStatus: '完成记账',
        claim: 500,
        offset: 200,
        fillDate: '2025-01-15',
        completeDate: '2025-01-18',
        project: '科研试制费/台账驱动测试专属项目甲',
        controlPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
      },
      // 全额冲销:100 − 100 = 0 → skipped。
      { docNo: 'TZ-V4-3', claim: 100, offset: 100, project: '科研试制费/台账驱动测试专属项目甲' },
      // 业务退单 → skipped。
      { docNo: 'TZ-V4-4', docStatus: '业务退单', project: '科研试制费/台账驱动测试专属项目甲' },
      // 项目未命中 → error 未映射项目。
      {
        docNo: 'TZ-V4-5',
        claim: 60,
        project: '科研试制费/完全无关的另一个项目',
        controlPath: '直接费用/其他/差旅费',
      },
    ]);

    const wb = await loadSettlementWorkbookIfMatch(buf);
    expect(wb).not.toBeNull();
    const batchId = await parseSettlement(wb!, projectId, adminUser(), '台账.xlsx', buf);

    // 原件留存:上传字节随批次落库。
    const stored = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { templateVersion: true, fileData: true, fileSizeBytes: true },
    });
    expect(stored?.templateVersion).toBe(SETTLEMENT_V4_TEMPLATE_VERSION);
    expect(stored?.fileData?.equals(buf)).toBe(true);

    const preview = await getSettlementBatch(batchId, adminUser());
    expect(preview.templateVersion).toBe(SETTLEMENT_V4_TEMPLATE_VERSION);
    // 待导入:TZ-V4-1/2;错误(未映射):TZ-V4-5;跳过:全额冲销 + 业务退单。
    expect(preview.pending).toHaveLength(2);
    expect(preview.errors).toHaveLength(1);
    expect(preview.skippedCount).toBe(2);

    const byDoc = (doc: string) =>
      [...preview.pending, ...preview.duplicates, ...preview.errors].find(
        (r) => r.parsedData.docNo === doc,
      );
    const r1 = byDoc('TZ-V4-1')!;
    expect(r1.parsedData.status).toBe('FINANCE_APPROVAL');
    expect(r1.parsedData.amount).toBe('80.00');
    expect(r1.parsedData.budgetYear).toBe(2025);
    expect(r1.parsedData.businessDate).toBe('2025-11-25');
    expect(r1.parsedData.completedDate).toBe('2025-11-28');
    expect(r1.parsedData.subjectId).toBe(leafTravelId);
    expect(r1.parsedData.targetProjectId).toBe(projectId);
    expect(r1.parsedData.finCode).toBe('1891953874GN24003E');

    const r2 = byDoc('TZ-V4-2')!;
    expect(r2.parsedData.status).toBe('PAID');
    expect(r2.parsedData.amount).toBe('300.00');
    // 跨年填报:年度取「年度」列(2024),不是填报日期年份(2025)。
    expect(r2.parsedData.businessDate).toBe('2025-01-15');
    expect(r2.parsedData.budgetYear).toBe(2024);

    const r5 = byDoc('TZ-V4-5')!;
    expect(r5.errors.some((e) => e.message.includes('未映射项目'))).toBe(true);

    // 确认入账:预选科目的两行 → 写业务记录(净额 + 科目 + 完成日期)。
    const res = await confirmSettlementImport(
      batchId,
      preview.pending.map((r) => r.rowId),
      adminUser(),
    );
    expect(res.created).toBe(2);
    const rec1 = await prisma.businessRecord.findFirst({
      where: { projectId, docNo: 'TZ-V4-1' },
    });
    expect(rec1?.amount.toFixed(2)).toBe('80.00');
    expect(rec1?.subjectId).toBe(leafTravelId);
    expect(rec1?.completedDate?.toISOString().slice(0, 10)).toBe('2025-11-28');
  });

  it('v4:统一入口自动预映射承载项目;已入库同号同额再传 → 硬重复', async () => {
    const buf = await buildV4Xlsx([
      {
        docNo: 'TZ-V4-U1',
        year: 2025,
        docStatus: '待记账',
        claim: 120,
        offset: 0,
        fillDate: '2025-10-10',
        project: '科研试制费/台账驱动测试专属项目甲',
        controlPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
      },
    ]);
    const ok = await parseSettlementUnified(buf, adminUser(), '统一台账.xlsx');
    expect(ok.needsHost).toBe(false);
    expect(ok.batchProjectId).toBe(projectId);
    const stored = await prisma.importBatch.findUnique({
      where: { id: ok.batchId! },
      select: { fileData: true, templateVersion: true },
    });
    expect(stored?.templateVersion).toBe(SETTLEMENT_V4_TEMPLATE_VERSION);
    expect(stored?.fileData?.equals(buf)).toBe(true);

    // 先确认入账,再重传同号同额文件 → 硬重复(查重比对的是已入库业务记录)。
    const preview1 = await getSettlementBatch(ok.batchId!, adminUser());
    await confirmSettlementImport(
      ok.batchId!,
      preview1.pending.map((r) => r.rowId),
      adminUser(),
    );
    const again = await parseSettlementUnified(buf, adminUser(), '统一台账-重.xlsx');
    const preview2 = await getSettlementBatch(again.batchId!, adminUser());
    expect(preview2.duplicates).toHaveLength(1);
    expect(preview2.duplicates[0]?.duplicateLevel).toBe('hard');
  });

  it('v4:缺「冲销金额(元)」列 → 422(不得静默按报销全额入账;codex 评审 P1)', async () => {
    const headers = V4_HEADERS.filter((h) => h !== '冲销金额(元)');
    const buf = await buildV4Xlsx(
      [
        {
          docNo: 'TZ-V4-NO-OFFSET',
          claim: 500,
          project: '科研试制费/台账驱动测试专属项目甲',
          controlPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        },
      ],
      headers,
    );
    const wb = await loadSettlementWorkbookIfMatch(buf);
    await expect(
      parseSettlement(wb!, projectId, adminUser(), 'no-offset.xlsx', buf),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('冲销金额(元)'),
    });
  });

  it('v4:关键列重复表头(报销金额×2)→ 422(不得静默取最后一列;codex 评审 P2)', async () => {
    // 复刻 v3 真实导出特征——无关列允许重复(合同编号×2),关键列重复必须拒绝。
    const headers = [...V4_HEADERS.slice(0, 7), '报销金额(元)', ...V4_HEADERS.slice(7)];
    const buf = await buildV4Xlsx(
      [
        {
          docNo: 'TZ-V4-DUP-HEADER',
          claim: 500,
          project: '科研试制费/台账驱动测试专属项目甲',
          controlPath: '直接费用/会议、差旅、国际合作与交流/差旅费',
        },
      ],
      headers,
    );
    const wb = await loadSettlementWorkbookIfMatch(buf);
    await expect(
      parseSettlement(wb!, projectId, adminUser(), 'dup-header.xlsx', buf),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('重复表头'),
    });
  });
});
