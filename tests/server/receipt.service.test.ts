import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import {
  createReceipt,
  deleteReceipt,
  listReceipts,
  updateReceipt,
} from '@/server/services/receipt.service';

// 集成测试直连真实 PG(:5434)。建项目 + 到账记录,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('receipt.service (integration, real PG)', () => {
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
        { id: adminId, name: 'admin-receipt', role: UserRole.ADMIN },
        { id: outsiderId, name: 'outsider-receipt', role: UserRole.USER },
      ],
    });
    createdUserIds.push(adminId, outsiderId);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目(自动成为 owner/member)。 */
  async function seedProject(suffix: string) {
    const code = `TR-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: `receipt ${suffix}` },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    return project;
  }

  it('createReceipt: 成功;listReceipts cumulative = 金额之和;审计 create 同事务', async () => {
    const project = await seedProject('CREATE');

    const r1 = await createReceipt(
      project.id,
      { receiptDate: '2026-06-01', amount: '100.00', summary: '第一笔' },
      adminUser(),
    );
    expect(r1.amount.toFixed(2)).toBe('100.00');
    expect(r1.creatorId).toBe(adminId);
    expect(r1.projectId).toBe(project.id);
    expect(r1.summary).toBe('第一笔');

    const r2 = await createReceipt(
      project.id,
      { receiptDate: '2026-07-01', amount: '250.50', remark: '尾款' },
      adminUser(),
    );
    expect(r2.amount.toFixed(2)).toBe('250.50');

    const { records, cumulative } = await listReceipts(project.id, adminUser());
    expect(records.length).toBe(2);
    // 累计 = 100 + 250.50 = 350.50。
    expect(cumulative).toBe('350.50');
    // 顺序:按 receiptDate desc → r2 在前。
    expect(records[0].id).toBe(r2.id);
    // list 返回带 creator 名称。
    expect(records[0].creator).toMatchObject({ id: adminId, name: 'admin-receipt' });

    // 审计 create 同事务写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: r1.id, action: 'create', objectType: 'receipt_records' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.projectId).toBe(project.id);
  });

  it('createReceipt: amount <= 0 → HTTPError 422', async () => {
    const project = await seedProject('NEG');
    await expect(
      createReceipt(project.id, { receiptDate: '2026-06-01', amount: '0.00' }, adminUser()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('createReceipt: receiptDate 格式错误 → HTTPError 422', async () => {
    const project = await seedProject('DATE');
    await expect(
      createReceipt(project.id, { receiptDate: '2026/06/01', amount: '10.00' }, adminUser()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('updateReceipt: 改金额后 cumulative 重算;审计 update 留痕', async () => {
    const project = await seedProject('UPD');
    const r = await createReceipt(
      project.id,
      { receiptDate: '2026-06-01', amount: '100.00', summary: '原' },
      adminUser(),
    );

    const updated = await updateReceipt(r.id, { amount: '300.00', summary: '改后' }, adminUser());
    expect(updated.amount.toFixed(2)).toBe('300.00');
    expect(updated.summary).toBe('改后');

    const { cumulative } = await listReceipts(project.id, adminUser());
    expect(cumulative).toBe('300.00');

    const audit = await prisma.auditLog.findFirst({
      where: { objectId: r.id, action: 'update', objectType: 'receipt_records' },
    });
    expect(audit).not.toBeNull();
  });

  it('deleteReceipt: 物理删除;累计回落;保留 delete 审计日志', async () => {
    const project = await seedProject('DEL');
    const r = await createReceipt(
      project.id,
      { receiptDate: '2026-06-01', amount: '500.00', summary: '待删' },
      adminUser(),
    );

    // 删除前累计 500。
    let res = await listReceipts(project.id, adminUser());
    expect(res.cumulative).toBe('500.00');

    await deleteReceipt(r.id, adminUser());

    // 物理删除:行已不存在。
    const still = await prisma.receiptRecord.findUnique({ where: { id: r.id } });
    expect(still).toBeNull();

    // 累计回落到 0。
    res = await listReceipts(project.id, adminUser());
    expect(res.records.length).toBe(0);
    expect(res.cumulative).toBe('0.00');

    // 保留 delete 审计。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: r.id, action: 'delete', objectType: 'receipt_records' },
    });
    expect(audit).not.toBeNull();
  });

  it('权限:非项目成员(无 OWNER 身份)createReceipt → 403', async () => {
    const project = await seedProject('PERM');
    await expect(
      createReceipt(
        project.id,
        { receiptDate: '2026-06-01', amount: '10.00', summary: 'x' },
        outsiderUser(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('权限:非项目成员也可 listReceipts(v0.3.0 全局只读)', async () => {
    const project = await seedProject('PERMLIST');
    const result = await listReceipts(project.id, outsiderUser());
    expect(Array.isArray(result.records)).toBe(true);
  });
});
