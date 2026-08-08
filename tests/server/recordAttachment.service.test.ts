import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { createRecord, voidRecord } from '@/server/services/businessRecord.service';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import {
  listAttachments,
  getAttachmentData,
  createAttachment,
  deleteAttachment,
  listForExport,
  countForExport,
} from '@/server/services/recordAttachment.service';
import { MAX_ATTACHMENT_BYTES_DEFAULT } from '@/lib/attachments/config';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 审批 + 业务记录 + 附件,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.recordAttachment.deleteMany({ where: { record: { projectId } } }).catch(() => {});
  await prisma.businessRecordHistory
    .deleteMany({ where: { businessRecord: { projectId } } })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

/**
 * 合法初始预算 payload:1 根(非叶)+ 1 叶(A),1 年度 2026,总额 1000。
 * createProject 不会自动建立科目树;走 createDraft→submitDraft→approveApplication 才会落库叶科目,
 * 从而使 prisma.budgetSubject.findFirst({ projectId, isLeaf: true }) 有结果。
 */
function validPayload(): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [{ year: 2026, amount: '1000.00' }],
    subjects: [
      { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
      { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      {
        year: 2026,
        subjectCode: 'A',
        amount: '1000.00',
        unit: '次',
        quantity: '10.00',
        unitPrice: '100.00',
      },
    ],
    subjectTotalBudgets: [{ subjectCode: 'A', amount: '1000.00' }],
  };
}

describe('recordAttachment.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let outsiderId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });
  const outsiderUser = () => ({ id: outsiderId, role: UserRole.USER });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'admin-att', role: UserRole.ADMIN },
        { id: outsiderId, name: 'outsider-att', role: UserRole.USER },
      ],
    });
    createdUserIds.push(adminId, outsiderId);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:建项目 + 编制 + 提交 + 审批生效 → 建业务记录 → 返回 { project, record }。 */
  async function seedRecord(suffix: string) {
    const code = `ATT-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `att ${suffix}` }, adminUser());
    createdProjectIds.push(project.id);

    // createProject 不建立科目;走 initialBudget 流程落库叶科目。
    const { appId } = await createDraft(project.id, validPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subject = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, isLeaf: true },
    });
    if (!subject) throw new Error('测试夹具:项目无叶科目');
    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: subject.id,
        amount: '100.00',
        businessDate: '2026-08-05',
        handler: '张三',
        summary: `附件测试-${suffix}`,
        status: 'PLACEHOLDER',
      },
      adminUser(),
    );
    return { project, record };
  }

  const samplePdf = (size = 100): Buffer => Buffer.alloc(size, 0x25); // %

  it('createAttachment: 成功;listAttachments 不含 data;审计同事务', async () => {
    const { record } = await seedRecord('CREATE');
    const meta = await createAttachment(
      record.id,
      { name: '发票.pdf', type: 'application/pdf', size: 100, buffer: samplePdf() },
      adminUser(),
    );
    expect(meta.fileName).toBe('发票.pdf');
    expect(meta.sizeBytes).toBe(100);
    expect(meta.uploadedBy).toMatchObject({ id: adminId });

    const list = await listAttachments(record.id, adminUser());
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(meta.id);
    // AttachmentMeta 不应携带 data 字段。
    expect((list[0] as unknown as Record<string, unknown>).data).toBeUndefined();

    const audit = await prisma.auditLog.findFirst({
      where: {
        objectId: meta.id,
        action: 'record_attachment_upload',
        objectType: 'record_attachments',
      },
    });
    expect(audit).not.toBeNull();
  });

  it('createAttachment: 超 50MB → 413', async () => {
    const { record } = await seedRecord('BIG');
    await expect(
      createAttachment(
        record.id,
        {
          name: 'big.pdf',
          type: 'application/pdf',
          size: MAX_ATTACHMENT_BYTES_DEFAULT + 1,
          buffer: samplePdf(),
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('createAttachment: 非白名单类型 → 415', async () => {
    const { record } = await seedRecord('TYPE');
    await expect(
      createAttachment(
        record.id,
        { name: 'a.exe', type: 'application/x-msdownload', size: 10, buffer: samplePdf() },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('createAttachment: 记录不存在 → 404', async () => {
    await expect(
      createAttachment(
        uuidv7(),
        { name: 'a.pdf', type: 'application/pdf', size: 10, buffer: samplePdf() },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('createAttachment: 已作废记录 → 400', async () => {
    const { record } = await seedRecord('VOID');
    await voidRecord(record.id, '测试作废', adminUser());
    await expect(
      createAttachment(
        record.id,
        { name: 'v.pdf', type: 'application/pdf', size: 10, buffer: samplePdf() },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('getAttachmentData: 返回 data 与上传一致', async () => {
    const { record } = await seedRecord('GET');
    const buf = Buffer.from('HELLO-ATTACHMENT');
    const meta = await createAttachment(
      record.id,
      // 扩展名与 MIME 必须同属一个白名单组:.pdf + application/pdf。
      { name: 'r.pdf', type: 'application/pdf', size: buf.length, buffer: buf },
      adminUser(),
    );
    const { data } = await getAttachmentData(meta.id, record.id, adminUser());
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.equals(buf)).toBe(true);
  });

  it('deleteAttachment: 物理删除;留 delete 审计', async () => {
    const { record } = await seedRecord('DEL');
    const meta = await createAttachment(
      record.id,
      { name: 'd.pdf', type: 'application/pdf', size: 10, buffer: samplePdf() },
      adminUser(),
    );
    await deleteAttachment(meta.id, record.id, adminUser());
    const still = await prisma.recordAttachment.findUnique({ where: { id: meta.id } });
    expect(still).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: meta.id, action: 'record_attachment_delete' },
    });
    expect(audit).not.toBeNull();
  });

  it('IDOR 防护:recordId 不匹配 → get/delete 均 404(正确 recordId 仍可用)', async () => {
    // R1:附件真正归属的记录;R2:另一个不同记录(用于模拟伪造 URL 的越权请求)。
    const { record: r1 } = await seedRecord('IDOR-R1');
    const { record: r2 } = await seedRecord('IDOR-R2');
    const buf = Buffer.from('IDOR-CONTENT');
    const meta = await createAttachment(
      r1.id,
      { name: 'idor.pdf', type: 'application/pdf', size: buf.length, buffer: buf },
      adminUser(),
    );

    // 1) 用错误的 recordId(R2)读取/删除,均应 404,不泄露附件存在性。
    await expect(getAttachmentData(meta.id, r2.id, adminUser())).rejects.toMatchObject({
      status: 404,
      message: '附件不存在',
    });
    await expect(deleteAttachment(meta.id, r2.id, adminUser())).rejects.toMatchObject({
      status: 404,
      message: '附件不存在',
    });

    // 2) 删除失败后附件仍存在(确认 404 没有副作用)。
    const still = await prisma.recordAttachment.findUnique({ where: { id: meta.id } });
    expect(still).not.toBeNull();

    // 3) 用正确的 recordId(R1)读取正常返回,且字节一致。
    const { data } = await getAttachmentData(meta.id, r1.id, adminUser());
    expect(data.equals(buf)).toBe(true);

    // 4) 用不存在的随机 recordId 也应 404(而非越权读取)。
    await expect(getAttachmentData(meta.id, uuidv7(), adminUser())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('权限:非成员 createAttachment → 403;但可 listAttachments(全局只读)', async () => {
    const { record } = await seedRecord('PERM');
    // USER 全局只读:listAttachments 走 project:view,允许。
    const list = await listAttachments(record.id, outsiderUser());
    expect(Array.isArray(list)).toBe(true);
    // createAttachment 走 record:edit,非项目成员 → 403。
    await expect(
      createAttachment(
        record.id,
        { name: 'a.pdf', type: 'application/pdf', size: 10, buffer: samplePdf() },
        outsiderUser(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('listForExport: 按年度/科目过滤,返回 record + meta + data', async () => {
    const { project, record } = await seedRecord('EXPORT');
    await createAttachment(
      record.id,
      { name: 'e1.pdf', type: 'application/pdf', size: 5, buffer: Buffer.from('E1') },
      adminUser(),
    );
    const rows = await listForExport(project.id, { budgetYear: 2026 }, adminUser());
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const hit = rows.find((r) => r.attachment.fileName === 'e1.pdf');
    expect(hit).toBeTruthy();
    expect(hit!.record.summary).toContain('附件测试-EXPORT');
    expect(Buffer.isBuffer(hit!.data)).toBe(true);
    // Task 2:返回类型扩展,新增 subjectId/amount/budgetYear/status 字段
    expect(hit!.record.subjectId).toBe(record.subjectId);
    expect(hit!.record.amount.toFixed(2)).toBe('100.00');
    expect(hit!.record.budgetYear).toBe(2026);
    expect(hit!.record.status).toBe('PLACEHOLDER');
    // 年度不匹配 → 不含。
    const none = await listForExport(project.id, { budgetYear: 2099 }, adminUser());
    expect(none.find((r) => r.attachment.fileName === 'e1.pdf')).toBeUndefined();
    // 科目匹配 → 含;随机不存在的科目 → 不含。
    const bySubject = await listForExport(project.id, { subjectId: record.subjectId }, adminUser());
    expect(bySubject.find((r) => r.attachment.fileName === 'e1.pdf')).toBeTruthy();
    const wrongSubject = await listForExport(project.id, { subjectId: uuidv7() }, adminUser());
    expect(wrongSubject.find((r) => r.attachment.fileName === 'e1.pdf')).toBeUndefined();
  });

  it('countForExport: 计数正确且尊重年度/科目过滤(与 listForExport 同口径,不载 data)', async () => {
    const { project, record } = await seedRecord('COUNT');
    await createAttachment(
      record.id,
      { name: 'c1.pdf', type: 'application/pdf', size: 4, buffer: Buffer.from('C1') },
      adminUser(),
    );
    // 年度匹配 → 至少含本条。
    const cYear = await countForExport(project.id, { budgetYear: 2026 }, adminUser());
    expect(cYear).toBeGreaterThanOrEqual(1);
    // 年度不匹配 → 不含本条(本应严格小于 cYear,但其他测试可能共享项目;用 2099 断言 0)。
    const c2099 = await countForExport(project.id, { budgetYear: 2099 }, adminUser());
    expect(c2099).toBe(0);
    // 科目匹配 → 至少含本条。
    const cSubject = await countForExport(project.id, { subjectId: record.subjectId }, adminUser());
    expect(cSubject).toBeGreaterThanOrEqual(1);
    // 不存在的科目 → 0。
    const cWrongSubject = await countForExport(project.id, { subjectId: uuidv7() }, adminUser());
    expect(cWrongSubject).toBe(0);

    // 与 listForExport 数量一致(同 where 口径)。
    const rows = await listForExport(project.id, { budgetYear: 2026 }, adminUser());
    expect(rows.length).toBe(cYear);
  });

  it('countForExport: 非成员(全局只读 USER)走 project:view,同口径可计数', async () => {
    const { project, record } = await seedRecord('COUNT-PERM');
    await createAttachment(
      record.id,
      { name: 'cp.pdf', type: 'application/pdf', size: 3, buffer: Buffer.from('CP') },
      adminUser(),
    );
    // outsider 是非成员 USER,project:view 放行(与 listForExport/listAttachments 同权限路径)。
    const c = await countForExport(project.id, { budgetYear: 2026 }, outsiderUser());
    expect(c).toBeGreaterThanOrEqual(1);
  });
});
