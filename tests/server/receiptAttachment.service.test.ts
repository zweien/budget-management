import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { createReceipt, listReceipts } from '@/server/services/receipt.service';
import {
  createReceiptAttachment,
  deleteReceiptAttachment,
  getReceiptAttachmentData,
  listReceiptAttachments,
  type ReceiptAttachmentInput,
} from '@/server/services/receiptAttachment.service';

/** 到账流水附件集成测试(直连真实 PG :5434)。 */
describe('receiptAttachment.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let outsiderId: string; // USER 全局只读:可看附件,不可增删
  let projectId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });
  const outsiderUser = () => ({ id: outsiderId, role: UserRole.USER });

  const file = (name = '到账凭证.png'): ReceiptAttachmentInput => ({
    name,
    type: 'image/png',
    size: 8,
    buffer: Buffer.from('receipt!'),
  });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.create({ data: { id: adminId, name: 'admin-ratt', role: UserRole.ADMIN } });
    await prisma.user.create({
      data: { id: outsiderId, name: 'outsider-ratt', role: UserRole.USER },
    });
    createdUserIds.push(adminId, outsiderId);

    const project = await createProject(
      {
        code: `RATT-${uuidv7().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
        name: '到账附件测试',
      },
      adminUser(),
    );
    projectId = project.id;
    createdProjectIds.push(projectId);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      // receipt_attachments 随 receipt 级联;其余按依赖序清理。
      await prisma.receiptRecord.deleteMany({ where: { projectId: id } }).catch(() => {});
      await prisma.projectBudget.deleteMany({ where: { projectId: id } }).catch(() => {});
      await prisma.projectMember.deleteMany({ where: { projectId: id } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { projectId: id } }).catch(() => {});
      await prisma.project.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('上传/列表/下载/删除 全链路 + IDOR 防护 + 审计', async () => {
    const receipt = await createReceipt(
      projectId,
      { amount: '1000.00', receiptDate: '2026-06-01', summary: '首笔到账' },
      adminUser(),
    );

    // 初始:listReceipts 计数为 0。
    const emptyList = await listReceipts(projectId, adminUser());
    expect(emptyList.records.find((r) => r.id === receipt.id)?.attachmentCount).toBe(0);

    // 上传 → 元数据返回(不含二进制字段)。
    const meta = await createReceiptAttachment(receipt.id, file(), adminUser());
    expect(meta.fileName).toBe('到账凭证.png');
    expect(meta.receiptId).toBe(receipt.id);
    expect(meta.uploadedBy.name).toBe('admin-ratt');

    // 列表:元数据数组;listReceipts 计数为 1。
    const list = await listReceiptAttachments(receipt.id, adminUser());
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(meta.id);
    const oneList = await listReceipts(projectId, adminUser());
    expect(oneList.records.find((r) => r.id === receipt.id)?.attachmentCount).toBe(1);

    // 下载:字节一致。
    const got = await getReceiptAttachmentData(meta.id, receipt.id, adminUser());
    expect(got.data.toString()).toBe('receipt!');
    expect(got.meta.contentType).toBe('image/png');

    // IDOR:附件 id 配错 receiptId → 404(不泄露存在性)。
    const other = await createReceipt(
      projectId,
      { amount: '50.00', receiptDate: '2026-06-02' },
      adminUser(),
    );
    await expect(getReceiptAttachmentData(meta.id, other.id, adminUser())).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteReceiptAttachment(meta.id, other.id, adminUser())).rejects.toMatchObject({
      status: 404,
    });

    // 全局只读 USER:可列表/下载,不可上传/删除(record:edit 403)。
    await expect(listReceiptAttachments(receipt.id, outsiderUser())).resolves.toHaveLength(1);
    await expect(
      getReceiptAttachmentData(meta.id, receipt.id, outsiderUser()),
    ).resolves.toBeTruthy();
    await expect(
      createReceiptAttachment(receipt.id, file('x.png'), outsiderUser()),
    ).rejects.toMatchObject({ status: 403 });

    // 删除 → 列表空;审计含 upload/delete 两行。
    await deleteReceiptAttachment(meta.id, receipt.id, adminUser());
    await expect(listReceiptAttachments(receipt.id, adminUser())).resolves.toHaveLength(0);
    const audits = await prisma.auditLog.findMany({
      where: { projectId, objectType: 'receipt_attachments' },
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      'receipt_attachment_delete',
      'receipt_attachment_upload',
    ]);
  });

  it('附件校验与 record 附件同款:类型白名单拒绝', async () => {
    const receipt = await createReceipt(
      projectId,
      { amount: '20.00', receiptDate: '2026-06-03' },
      adminUser(),
    );
    await expect(
      createReceiptAttachment(
        receipt.id,
        { name: 'evil.sh', type: 'application/x-sh', size: 4, buffer: Buffer.from('boom') },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('不存在的到账记录 → 404', async () => {
    await expect(listReceiptAttachments(uuidv7(), adminUser())).rejects.toMatchObject({
      status: 404,
    });
  });
});
