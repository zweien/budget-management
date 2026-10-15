import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import {
  loadSettlementWorkbookIfMatch,
  parseSettlementUnified,
  listMySettlementBatches,
  getSettlementBatch,
} from '@/server/services/settlementImport.service';

/**
 * 统一导入入口(POST /api/imports/settlement 背后的 parseSettlementUnified)集成测试:
 * 不依赖项目上下文解析 v3 文件;批次承载项目 = 自动预映射第一目标 > 显式 host;
 * 全未命中 → needsHost(附候选);仅接受 v3。
 */

const V3_HEADERS = [
  '单据编号',
  '单据状态',
  '申请日期',
  '金额',
  '经办人',
  '备注',
  '科研项目名称',
  '开支细项名称',
  '摘要',
];

async function buildV3Xlsx(
  rows: Array<{ docNo: string; amount: number; projectName: string; remark?: string }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(V3_HEADERS);
  for (const r of rows) {
    ws.addRow([
      r.docNo,
      '完成记账',
      '2025-09-01',
      r.amount,
      '经办人',
      r.remark ?? '',
      r.projectName,
      '直接费用/会议、差旅、国际合作与交流/差旅费',
      '',
    ]);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/** v1(填制日期版)个人结算单——非 v3,应被统一入口拒绝。 */
async function buildV1Xlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('个人结算单查询');
  ws.addRow(['个人结算单查询']);
  ws.addRow(['时间:2026年08月31日']);
  ws.addRow(['单位:计算机学院']);
  ws.addRow(['单据编号', '单据状态', '填制日期', '事项', '金额', '经办人']);
  ws.addRow(['TYBX-V1-1', '完成记账', '2026-01-01', '事项', 100, '经办人']);
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
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId: projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('settlementImport unified entry (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let projectAId = '';
  const projectNameA = '统一入口测试项目甲';

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'unified-admin', role: UserRole.ADMIN },
    });
    createdUserIds.push(adminId);
    const project = await createProject(
      {
        code: `UNI-${uuidv7().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
        name: projectNameA,
      },
      { id: adminId, role: UserRole.ADMIN },
    );
    projectAId = project.id;
    createdProjectIds.push(project.id);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('unified:多项目文件 → 批次承载=自动预映射第一目标;needsHost 附候选', async () => {
    // 两个文件项目名:A 命中甲;B 无关联(未命中)。
    const buf = await buildV3Xlsx([
      { docNo: 'UNI-A1', amount: 100, projectName: `其他专项科学技术费/${projectNameA}` },
      { docNo: 'UNI-B1', amount: 200, projectName: '其他专项科学技术费/完全无关的另一个项目' },
    ]);

    // 未显式指定承载:第一个行项目名唯一命中甲 → 批次承载=甲。
    const ok = await parseSettlementUnified(
      buf,
      { id: adminId, role: UserRole.ADMIN },
      'multi.xlsx',
    );
    expect(ok.needsHost).toBe(false);
    expect(ok.batchProjectId).toBe(projectAId);
    const preview = await getSettlementBatch(ok.batchId!, { id: adminId, role: UserRole.ADMIN });
    expect(preview.pending.filter((r) => r.parsedData.targetProjectId === projectAId)).toHaveLength(
      1,
    );
    const unmapped = preview.errors.find((r) => r.parsedData.docNo === 'UNI-B1');
    expect(unmapped?.errors.some((e) => e.message.includes('未映射项目'))).toBe(true);
    // 批次承载 = 种子项目甲本身:不在测试内清理(测试 3 依赖);afterAll 统一清理。

    // 全未命中且未指定承载 → needsHost=true + 候选含可导入项目。
    const buf2 = await buildV3Xlsx([
      { docNo: 'UNI-C1', amount: 300, projectName: '其他专项科学技术费/完全无关的另一个项目' },
    ]);
    const needs = await parseSettlementUnified(
      buf2,
      { id: adminId, role: UserRole.ADMIN },
      'nohit.xlsx',
    );
    expect(needs.needsHost).toBe(true);
    expect(needs.batchId).toBeNull();
    expect((needs.mappableProjects ?? []).some((p) => p.id === projectAId)).toBe(true);

    // 显式承载=甲 重传:批次落甲。
    const hosted = await parseSettlementUnified(
      buf2,
      { id: adminId, role: UserRole.ADMIN },
      'nohit.xlsx',
      projectAId,
    );
    expect(hosted.needsHost).toBe(false);
    expect(hosted.batchProjectId).toBe(projectAId);
    // 承载项目 = 种子项目甲:不在测试内清理(后续用例依赖);afterAll 统一清理。
  });

  it('unified:仅接受 v3(v1 结算单 → 422 提示去项目内导入)', async () => {
    const v1 = await buildV1Xlsx();
    await expect(
      parseSettlementUnified(v1, { id: adminId, role: UserRole.ADMIN }, 'v1.xlsx'),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('listMySettlementBatches:仅本人批次,含承载项目与行数', async () => {
    const buf = await buildV3Xlsx([
      { docNo: 'UNI-MINE-1', amount: 5, projectName: `其他专项科学技术费/${projectNameA}` },
    ]);
    await parseSettlementUnified(buf, { id: adminId, role: UserRole.ADMIN }, 'mine.xlsx');
    const mine = await listMySettlementBatches({ id: adminId, role: UserRole.ADMIN });
    expect(mine.length).toBeGreaterThan(0);
    expect(
      mine.every((b) => ['settlement-1.0', 'settlement-2.0'].includes(b.templateVersion)),
    ).toBe(true);
    // 他人看不到(admin 创建的批次)。
    const outsiderId = uuidv7();
    await prisma.user.create({
      data: { id: outsiderId, name: 'unified-outsider', role: UserRole.ADMIN },
    });
    createdUserIds.push(outsiderId);
    const other = await listMySettlementBatches({ id: outsiderId, role: UserRole.ADMIN });
    expect(other).toHaveLength(0);
  });
});
