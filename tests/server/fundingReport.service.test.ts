import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, UserRole } from '@prisma/client';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { fromStored } from '@/lib/decimal';
import { DEFAULT_DETAIL_FIELDS, DEFAULT_SUMMARY_COLUMNS } from '@/lib/fundingReport';
import {
  buildFundingReportData,
  buildFundingReportDocx,
  chineseNumber,
  exportFundingReport,
  toWanYuan,
  type DetailRowData,
  type FundingReportData,
} from '@/server/services/fundingReport.service';
import { contentDispositionAttachment } from '@/server/services/migrationPackage.service';
import { DETAIL_FIELD_KEYS } from '@/lib/fundingReport';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';

/**
 * 经费报告集成测试(真实 PG,与 ledger.service.test 同款基建):
 * 三级科目树验证层级裁剪/上卷/编号/万元格式/明细分节排序;docx 走 zip 冒烟
 * (PK 魔数 + document.xml 关键文案),版式保真由 docs/templates 比对人工验收。
 */

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetLock.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetAdjustmentLine
    .deleteMany({ where: { adjustment: { projectId } } })
    .catch(() => {});
  await prisma.budgetAdjustment.deleteMany({ where: { projectId } }).catch(() => {});
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
 * 三级树:直接费用 → 设备费(非叶) → 设备A/设备B(叶);材料费(叶);
 * 间接费用 → 管理费(叶)。预算:设备A 300、设备B 300、材料费 200、管理费 200。
 */
function treePayload(): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [{ year: 2026, amount: '1000.00' }],
    subjects: [
      { code: 'DIRECT', name: '直接费用', parentCode: null, isLeaf: false },
      { code: 'DEV', name: '设备费', parentCode: 'DIRECT', isLeaf: false },
      { code: 'DEV_A', name: '设备A', parentCode: 'DEV', isLeaf: true },
      { code: 'DEV_B', name: '设备B', parentCode: 'DEV', isLeaf: true },
      { code: 'MAT', name: '材料费', parentCode: 'DIRECT', isLeaf: true },
      { code: 'INDIRECT', name: '间接费用', parentCode: null, isLeaf: false },
      { code: 'MGMT', name: '管理费', parentCode: 'INDIRECT', isLeaf: true },
    ],
    subjectBudgets: [
      {
        year: 2026,
        subjectCode: 'DEV_A',
        amount: '300.00',
        unit: '次',
        quantity: '3.00',
        unitPrice: '100.00',
      },
      {
        year: 2026,
        subjectCode: 'DEV_B',
        amount: '300.00',
        unit: '次',
        quantity: '3.00',
        unitPrice: '100.00',
      },
      {
        year: 2026,
        subjectCode: 'MAT',
        amount: '200.00',
        unit: '次',
        quantity: '2.00',
        unitPrice: '100.00',
      },
      {
        year: 2026,
        subjectCode: 'MGMT',
        amount: '200.00',
        unit: '次',
        quantity: '2.00',
        unitPrice: '100.00',
      },
    ],
    subjectTotalBudgets: [
      { subjectCode: 'DEV_A', amount: '300.00' },
      { subjectCode: 'DEV_B', amount: '300.00' },
      { subjectCode: 'MAT', amount: '200.00' },
      { subjectCode: 'MGMT', amount: '200.00' },
    ],
  };
}

async function insertRecord(input: {
  projectId: string;
  subjectId: string;
  amount: string;
  status: BusinessStatus;
  businessDate: string;
  docNo?: string;
  voucherNo?: string;
  isVoid?: boolean;
  createdById: string;
}) {
  return prisma.businessRecord.create({
    data: {
      id: uuidv7(),
      projectId: input.projectId,
      budgetYear: 2026,
      subjectId: input.subjectId,
      amount: fromStored(input.amount),
      businessDate: new Date(input.businessDate),
      handler: '测试经办人',
      summary: `摘要-${input.docNo ?? input.amount}`,
      status: input.status,
      isVoid: input.isVoid ?? false,
      docNo: input.docNo ?? null,
      voucherNo: input.voucherNo ?? null,
      createdById: input.createdById,
    },
  });
}

interface Seeded {
  projectId: string;
}

describe('fundingReport.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const admin = () => ({ id: adminId, role: UserRole.ADMIN });
  let seeded: Seeded;

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({ data: { id: adminId, name: 'admin-t14', role: UserRole.ADMIN } });

    const code = `T14-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: '经费报告测试项目' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    const { appId } = await createDraft(project.id, treePayload(), admin());
    await submitDraft(appId, admin());
    await approveApplication(appId, admin());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const byCode = new Map(subjects.map((s) => [s.code, s.id]));

    // 设备A:PAID 50(01-15, D-001)、PAID 100.50(03-01, D-003)、FIN 200(01-15, 无号)。
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('DEV_A')!,
      amount: '50.00',
      status: BusinessStatus.PAID,
      businessDate: '2026-01-15',
      docNo: 'D-001',
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('DEV_A')!,
      amount: '100.50',
      status: BusinessStatus.PAID,
      businessDate: '2026-03-01',
      docNo: 'D-003',
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('DEV_A')!,
      amount: '200.00',
      status: BusinessStatus.FINANCE_APPROVAL,
      businessDate: '2026-01-15',
      createdById: adminId,
    });
    // 设备B:CONTRACT 80(02-01, D-002);一条作废 PAID 999 不计。
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('DEV_B')!,
      amount: '80.00',
      status: BusinessStatus.CONTRACT,
      businessDate: '2026-02-01',
      docNo: 'D-002',
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('DEV_B')!,
      amount: '999.00',
      status: BusinessStatus.PAID,
      businessDate: '2026-02-02',
      docNo: 'D-VOID',
      isVoid: true,
      createdById: adminId,
    });
    // 材料费:PAID 30(05-01, 凭证号 记-1)。
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('MAT')!,
      amount: '30.00',
      status: BusinessStatus.PAID,
      businessDate: '2026-05-01',
      voucherNo: '记-1',
      createdById: adminId,
    });
    // 管理费:PLACEHOLDER 10(04-01, 无号);CONTRACT 7(04-01, D-009)——与无号记录同日,
    // 验证同申请日期下「有号在前、NULLS LAST」。
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('MGMT')!,
      amount: '10.00',
      status: BusinessStatus.PLACEHOLDER,
      businessDate: '2026-04-01',
      createdById: adminId,
    });
    await insertRecord({
      projectId: project.id,
      subjectId: byCode.get('MGMT')!,
      amount: '7.00',
      status: BusinessStatus.CONTRACT,
      businessDate: '2026-04-01',
      docNo: 'D-009',
      createdById: adminId,
    });

    seeded = { projectId: project.id };
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('chineseNumber:1~99 中文编号', () => {
    expect(chineseNumber(1)).toBe('一');
    expect(chineseNumber(10)).toBe('十');
    expect(chineseNumber(11)).toBe('十一');
    expect(chineseNumber(21)).toBe('二十一');
    expect(chineseNumber(99)).toBe('九十九');
  });

  it('toWanYuan:元→万元两位小数(四舍五入)', () => {
    expect(toWanYuan('12345.67')).toBe('1.23');
    expect(toWanYuan('150.50')).toBe('0.02');
    expect(toWanYuan('10000000.00')).toBe('1000.00');
    expect(toWanYuan('0.00')).toBe('0.00');
  });

  it('默认二级:汇总行编号/加粗/上卷/合计与万元格式;明细按二级分节并连续编号', async () => {
    const data = await buildFundingReportData(
      seeded.projectId,
      {
        level: 2,
        summaryColumns: [...DEFAULT_SUMMARY_COLUMNS],
        detailFields: [...DEFAULT_DETAIL_FIELDS],
      },
      admin(),
    );

    // 汇总行顺序与编号:一级「一、二、」+ 二级「1.2.3.」跨一级连续。
    expect(data.summary.rows.map((r) => r.label)).toEqual([
      '一、直接费用',
      '　1.设备费',
      '　2.材料费',
      '二、间接费用',
      '　3.管理费',
    ]);
    // 中间层(一级、二级非叶「设备费」)加粗;叶行不加粗。
    expect(data.summary.rows.map((r) => r.bold)).toEqual([true, true, false, true, false]);

    // 设备费 = 设备A+设备B 上卷:initial 600、paid 150.50、payable 280、occupied 430.50。
    const dev = data.summary.rows[1];
    expect(dev.cells.initial).toBe('0.06'); // 600 元 → 0.06 万元
    expect(dev.cells.paid).toBe('0.02'); // 150.50 → 0.02
    expect(dev.cells.payable).toBe('0.03'); // 280 → 0.03
    expect(dev.cells.occupied).toBe('0.04'); // 430.50 → 0.04

    // 合计 = Σ 一级行(作废 999 不计):1000 / 180.50 / 290 / 470.50。
    expect(data.summary.totalRow.cells.initial).toBe('0.10');
    expect(data.summary.totalRow.cells.paid).toBe('0.02');
    expect(data.summary.totalRow.cells.payable).toBe('0.03');
    expect(data.summary.totalRow.cells.occupied).toBe('0.05');

    // 明细:一级标题 → 三个二级小节;导语为子树上卷(元,千分位)。
    expect(data.detail).toHaveLength(2);
    const [direct, indirect] = data.detail;
    expect(direct.kind).toBe('heading');
    if (direct.kind !== 'heading') return;
    expect(direct.title).toBe('一、直接费用');
    expect(direct.children.map((c) => (c.kind === 'section' ? c.title : c.title))).toEqual([
      '1.设备费',
      '2.材料费',
    ]);
    const devSection = direct.children[0];
    if (devSection.kind !== 'section') return;
    expect(devSection.lead).toBe('共计430.50元，其中已完成150.50元，应付未付280.00元。');
    // 完成记账:申请日期升序(01-15 → 03-01);同日有号在前(无号 NULLS LAST 在应付侧)。
    expect(devSection.paid.map((r) => r.cells.amount)).toEqual(['50.00', '100.50']);
    // 应付未付:01-15 无号 200 → 02-01 D-002 80(日期升序)。
    expect(devSection.payable.map((r) => r.cells.amount)).toEqual(['200.00', '80.00']);
    expect(devSection.paidSumText).toBe('150.50');
    expect(devSection.payableSumText).toBe('280.00');
    // 单据编号/凭证编号缺省为空串;状态落中文。
    expect(devSection.payable[0].cells.docNo).toBe('');
    expect(devSection.payable[0].cells.status).toBe('财务系统审批');

    const matSection = direct.children[1];
    if (matSection.kind !== 'section') return;
    expect(matSection.paid[0].cells.voucherNo).toBe('记-1');

    expect(indirect.kind).toBe('heading');
    if (indirect.kind !== 'heading') return;
    const mgmt = indirect.children[0];
    if (mgmt.kind !== 'section') return;
    expect(mgmt.title).toBe('3.管理费');
    expect(mgmt.lead).toBe('共计17.00元，其中已完成0.00元，应付未付17.00元。');
    // 同日(04-01)两条应付未付:有号 D-009(7.00)在前,无号(10.00)NULLS LAST。
    expect(mgmt.payable.map((r) => r.cells.amount)).toEqual(['7.00', '10.00']);
    expect(mgmt.payable[0].cells.docNo).toBe('D-009');
    expect(mgmt.payable[0].cells.status).toBe('合同');
    expect(mgmt.payable[1].cells.docNo).toBe('');
    expect(mgmt.payable[1].cells.status).toBe('登记占位');
  });

  it('全部层级(三级):设备费转纯标题,设备A/B 各自成节,编号（1）（2）', async () => {
    const data = await buildFundingReportData(
      seeded.projectId,
      {
        level: 'all',
        summaryColumns: ['initial', 'occupied'],
        detailFields: ['appliedDate', 'amount'],
      },
      admin(),
    );

    // 汇总含三级行,编号（1）（2）在设备费内。
    const labels = data.summary.rows.map((r) => r.label);
    expect(labels).toEqual([
      '一、直接费用',
      '　1.设备费',
      '　　（1）设备A',
      '　　（2）设备B',
      '　2.材料费',
      '二、间接费用',
      '　3.管理费',
    ]);
    const devA = data.summary.rows[2];
    expect(devA.bold).toBe(false);
    expect(devA.cells.initial).toBe('0.03'); // 300 → 0.03

    // 明细:设备费下挂两个三级小节。
    const direct = data.detail[0];
    if (direct.kind !== 'heading') throw new Error('expect heading');
    const dev = direct.children[0];
    if (dev.kind !== 'heading') throw new Error('expect heading');
    expect(dev.title).toBe('1.设备费');
    expect(dev.children.map((c) => (c.kind === 'section' ? c.title : ''))).toEqual([
      '（1）设备A',
      '（2）设备B',
    ]);
    const devB = dev.children[1];
    if (devB.kind !== 'section') throw new Error('expect section');
    // 设备B:作废 999 不计,仅 CONTRACT 80。
    expect(devB.payable.map((r) => r.cells.amount)).toEqual(['80.00']);
    expect(devB.paid).toHaveLength(0);
    expect(devB.lead).toBe('共计80.00元，其中已完成0.00元，应付未付80.00元。');
  });

  it('周期括号:项目无起止日期时回退记录申请日期最早/最晚', async () => {
    const data = await buildFundingReportData(
      seeded.projectId,
      {
        level: 2,
        summaryColumns: [...DEFAULT_SUMMARY_COLUMNS],
        detailFields: [...DEFAULT_DETAIL_FIELDS],
      },
      admin(),
    );
    expect(data.periodText).toBe('2026年01月15日至2026年05月01日');
  });

  it('校验:汇总列/明细字段空选报 400', async () => {
    await expect(
      buildFundingReportData(
        seeded.projectId,
        { level: 2, summaryColumns: [], detailFields: ['amount'] },
        admin(),
      ),
    ).rejects.toMatchObject({ status: 400, message: '汇总表至少选择一个数值列' });
    await expect(
      buildFundingReportData(
        seeded.projectId,
        { level: 2, summaryColumns: ['initial'], detailFields: [] },
        admin(),
      ),
    ).rejects.toMatchObject({ status: 400, message: '明细表至少选择一个字段' });
  });

  it('exportFundingReport:docx 为合法 zip,document.xml 含模板关键文案', async () => {
    const { buffer, filename } = await exportFundingReport(
      seeded.projectId,
      {
        level: 2,
        summaryColumns: [...DEFAULT_SUMMARY_COLUMNS],
        detailFields: [...DEFAULT_DETAIL_FIELDS],
      },
      admin(),
    );
    expect(filename).toMatch(/^经费报告-T14-[0-9a-f]+-\d{8}\.docx$/);
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml')!.async('string');
    for (const needle of [
      '项目名称：经费报告测试项目',
      '一、协议经费执行情况',
      '金额单位：万元',
      '经费开支说明',
      '（2026年01月15日至2026年05月01日）',
      '（1）完成记账',
      '（2）应付未付',
      '1.设备费',
      '合　计',
    ]) {
      expect(xml).toContain(needle);
    }
  });

  it('合计自洽:两个一级科目各 50 元,行 0.01+0.01,合计 0.02(Σ 已舍入万元值)', async () => {
    // 单级树(两个根叶各 50),专测舍入尾差:精确总和 100 元 → 0.01,与可见列 0.02 矛盾。
    const code = `T14-R-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: '舍入尾差测试' },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    const { appId } = await createDraft(
      project.id,
      {
        projectTotal: '100.00',
        annualBudgets: [{ year: 2026, amount: '100.00' }],
        subjects: [
          { code: 'JIA', name: '甲', parentCode: null, isLeaf: true },
          { code: 'YI', name: '乙', parentCode: null, isLeaf: true },
        ],
        subjectBudgets: [
          {
            year: 2026,
            subjectCode: 'JIA',
            amount: '50.00',
            unit: '次',
            quantity: '1.00',
            unitPrice: '50.00',
          },
          {
            year: 2026,
            subjectCode: 'YI',
            amount: '50.00',
            unit: '次',
            quantity: '1.00',
            unitPrice: '50.00',
          },
        ],
        subjectTotalBudgets: [
          { subjectCode: 'JIA', amount: '50.00' },
          { subjectCode: 'YI', amount: '50.00' },
        ],
      },
      admin(),
    );
    await submitDraft(appId, admin());
    await approveApplication(appId, admin());
    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    for (const s of subjects) {
      await insertRecord({
        projectId: project.id,
        subjectId: s.id,
        amount: '50.00',
        status: BusinessStatus.PAID,
        businessDate: '2026-01-10',
        docNo: `R-${s.code}`,
        createdById: adminId,
      });
    }

    const data = await buildFundingReportData(
      project.id,
      { level: 1, summaryColumns: ['initial', 'paid'], detailFields: ['amount'] },
      admin(),
    );
    expect(data.summary.rows.map((r) => r.cells.paid)).toEqual(['0.01', '0.01']);
    expect(data.summary.totalRow.cells.paid).toBe('0.02');
    expect(data.summary.totalRow.cells.initial).toBe('0.02');
  });

  it('层级超树深收敛到实际树深(level=99 等价 all)', async () => {
    const data = await buildFundingReportData(
      seeded.projectId,
      { level: 99, summaryColumns: ['initial'], detailFields: ['amount'] },
      admin(),
    );
    expect(data.summary.rows.some((r) => r.label.includes('（1）设备A'))).toBe(true);
  });

  it('纯版式:未选金额列时合计行落首格「合计：N元」;仅金额列时同格「合计：N」', async () => {
    const data = fixtureData();
    const noAmount = await buildFundingReportDocx(data, {
      level: 2,
      summaryColumns: ['initial'],
      detailFields: ['summary'],
    });
    const xmlNoAmount = await docxXml(noAmount);
    expect(xmlNoAmount).toContain('合计：150.50元');

    const amountOnly = await buildFundingReportDocx(data, {
      level: 2,
      summaryColumns: ['initial'],
      detailFields: ['amount'],
    });
    const xmlAmountOnly = await docxXml(amountOnly);
    expect(xmlAmountOnly).toContain('合计：150.50');
    expect(xmlAmountOnly).not.toContain('合计：150.50元');
  });

  it('纯版式:10 字段全选时明细表列宽之和严格等于版心宽 8844', async () => {
    const buffer = await buildFundingReportDocx(fixtureData(), {
      level: 2,
      summaryColumns: ['initial'],
      detailFields: [...DETAIL_FIELD_KEYS],
    });
    const xml = await docxXml(buffer);
    const grids = [...xml.matchAll(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/g)];
    const detailGrid = grids[grids.length - 1]!;
    const widths = [...detailGrid[1]!.matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(DETAIL_FIELD_KEYS.length);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(8844);
    expect(widths.every((w) => w >= 600)).toBe(true);
  });

  it('Content-Disposition:项目编号含引号/分号时 ASCII 兜底不破头、filename* 可还原', () => {
    const malicious = '经费报告-A";x=y-20261117.docx';
    const header = contentDispositionAttachment(malicious);
    const ascii = /filename="([^"]*)"/.exec(header)![1]!;
    expect(ascii).not.toContain('"');
    expect(ascii).toContain('A_;x=y');
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(header)![1]!;
    expect(decodeURIComponent(encoded)).toBe(malicious);
  });

  it('onProgress:全程百分比单调不减、终值≥99,阶段文案覆盖取数/装配/Word/打包', async () => {
    const calls: Array<{ percent: number; phase: string }> = [];
    await exportFundingReport(
      seeded.projectId,
      {
        level: 2,
        summaryColumns: [...DEFAULT_SUMMARY_COLUMNS],
        detailFields: [...DEFAULT_DETAIL_FIELDS],
      },
      admin(),
      (percent, phase) => calls.push({ percent, phase }),
    );
    expect(calls.length).toBeGreaterThan(3);
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i]!.percent).toBeGreaterThanOrEqual(calls[i - 1]!.percent);
    }
    expect(calls[calls.length - 1]!.percent).toBeGreaterThanOrEqual(99);
    const phases = calls.map((c) => c.phase).join('|');
    expect(phases).toContain('读取业务记录');
    expect(phases).toContain('装配业务明细');
    expect(phases).toContain('生成 Word 明细');
    expect(phases).toContain('打包 Word 文档');
  });
});

async function docxXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file('word/document.xml')!.async('string');
}

/** 纯版式测试用最小数据(全部展示字符串已定,不依赖 DB)。 */
function fixtureData(): FundingReportData {
  const cells: Record<string, string> = {
    appliedDate: '2026-01-15',
    completedDate: '—',
    summary: '测试摘要',
    amount: '150.50',
    handler: '经办人',
    status: '已支出',
    docNo: 'D-001',
    voucherNo: '记-1',
    budgetYear: '2026',
    subject: '甲',
  };
  const row: DetailRowData = { cells: cells as DetailRowData['cells'] };
  const summaryCells = {
    initial: '0.01',
    current: '0.01',
    occupied: '0.01',
    paid: '0.01',
    payable: '0.00',
    balance: '0.00',
    rate: '100.00%',
  };
  return {
    project: { code: 'F-1', name: '纯函数测试' },
    periodText: null,
    summary: {
      columns: ['initial'],
      rows: [{ label: '一、甲', bold: false, cells: { ...summaryCells } }],
      totalRow: { label: '合　计', cells: { ...summaryCells } },
    },
    detail: [
      {
        kind: 'heading',
        level: 1,
        title: '一、甲',
        children: [
          {
            kind: 'section',
            title: '1.甲',
            lead: '共计150.50元，其中已完成150.50元，应付未付0.00元。',
            paid: [row],
            payable: [],
            paidSumText: '150.50',
            payableSumText: '0.00',
          },
        ],
      },
    ],
  };
}
