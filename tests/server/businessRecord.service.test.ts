import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BusinessStatus, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createProject } from '@/server/services/project.service';
import { getProjectLedger } from '@/server/services/ledger.service';
import {
  createRecord,
  listRecords,
  updateRecord,
  voidRecord,
  voidRecordsBatch,
  switchStatus,
} from '@/server/services/businessRecord.service';

// 集成测试直连真实 PG(:5434)。建项目 + 编制 + 审批 + 业务记录,需级联清理。
const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.businessRecordHistory
    .deleteMany({
      where: { businessRecord: { projectId } },
    })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
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
 * 构造合法 payload:1 根(非叶)+ 2 叶(A/B),1 年度 2026。
 * A=600、B=400,合计 1000。
 */
function validPayload(): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [{ year: 2026, amount: '1000.00' }],
    subjects: [
      { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
      { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
      { code: 'B', name: '叶B', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      // §enhance3:金额 = 数量 × 单价(service 端重算)。A 6×100=600;B 4×100=400。
      {
        year: 2026,
        subjectCode: 'A',
        amount: '600.00',
        unit: '次',
        quantity: '6.00',
        unitPrice: '100.00',
      },
      {
        year: 2026,
        subjectCode: 'B',
        amount: '400.00',
        unit: '次',
        quantity: '4.00',
        unitPrice: '100.00',
      },
    ],
    subjectTotalBudgets: [
      { subjectCode: 'A', amount: '600.00' },
      { subjectCode: 'B', amount: '400.00' },
    ],
  };
}

describe('businessRecord.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    await prisma.user.create({
      data: { id: adminId, name: 'admin-t6', role: UserRole.ADMIN },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) {
      await cleanupProject(id);
    }
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** helper:admin 建项目 + 编制 + 提交 + 审批生效 → 返回 { project, leafA, leafB, root }。 */
  async function seedApprovedProject(suffix: string) {
    const code = `T6-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject(
      { code, name: `t6 ${suffix}` },
      { id: adminId, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);

    const { appId } = await createDraft(project.id, validPayload(), adminUser());
    await submitDraft(appId, adminUser());
    await approveApplication(appId, adminUser());

    const subjects = await prisma.budgetSubject.findMany({ where: { projectId: project.id } });
    const root = subjects.find((s) => s.code === 'ROOT')!;
    const leafA = subjects.find((s) => s.code === 'A')!;
    const leafB = subjects.find((s) => s.code === 'B')!;

    return { project, root, leafA, leafB };
  }

  it('createRecord: 成功(100 < 600),overBudget=false;ledger 占用=100', async () => {
    const { project, leafA } = await seedApprovedProject('CREATE');

    const { record, overBudget } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '100.00',
        businessDate: '2026-06-01',
        handler: '经办人A',
        summary: '测试记录',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );

    expect(overBudget).toBe(false);
    expect(record.amount.toFixed(2)).toBe('100.00');
    expect(record.isVoid).toBe(false);
    expect(record.createdById).toBe(adminId);

    // ledger 实时反映:leafA occupied = 100。
    const ledger = await getProjectLedger(project.id, 2026, adminUser());
    const nodeA = ledger.nodes.find((n) => n.subjectId === leafA.id)!;
    expect(nodeA.totalOccupied).toBe('100.00');
    expect(nodeA.payable).toBe('100.00'); // PLACEHOLDER 计入应付未付
    expect(nodeA.paid).toBe('0.00');

    // 审计 create 同事务写入。
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: record.id, action: 'create', objectType: 'business_records' },
    });
    expect(audit).not.toBeNull();
  });

  it('createRecord: 超预算(700 > 600)→ overBudget=true,记录仍保存(§8.4)', async () => {
    const { project, leafA } = await seedApprovedProject('OVER');

    const { record, overBudget } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '700.00',
        businessDate: '2026-06-02',
        handler: '经办人A',
        summary: '超预算测试',
        status: BusinessStatus.CONTRACT,
      },
      adminUser(),
    );

    expect(overBudget).toBe(true);
    // §8.4 仍保存。
    expect(record.amount.toFixed(2)).toBe('700.00');
    const saved = await prisma.businessRecord.findUnique({ where: { id: record.id } });
    expect(saved).not.toBeNull();
    expect(saved!.amount.toFixed(2)).toBe('700.00');
  });

  it('createRecord: 非叶科目 → HTTPError 422', async () => {
    const { project, root } = await seedApprovedProject('NONLEAF');

    await expect(
      createRecord(
        project.id,
        {
          budgetYear: 2026,
          subjectId: root.id,
          amount: '100.00',
          businessDate: '2026-06-01',
          handler: '经办人A',
          summary: 'x',
          status: BusinessStatus.PLACEHOLDER,
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('createRecord: amount <= 0 → HTTPError 422', async () => {
    const { project, leafA } = await seedApprovedProject('NEG');

    await expect(
      createRecord(
        project.id,
        {
          budgetYear: 2026,
          subjectId: leafA.id,
          amount: '0.00',
          businessDate: '2026-06-01',
          handler: '经办人A',
          summary: 'x',
          status: BusinessStatus.PLACEHOLDER,
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('voidRecord: 作废后 ledger 占用回落(§8.6 实时解除);写 history + 不物理删除', async () => {
    const { project, leafA } = await seedApprovedProject('VOID');

    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '200.00',
        businessDate: '2026-06-03',
        handler: '经办人A',
        summary: '待作废',
        status: BusinessStatus.CONTRACT,
      },
      adminUser(),
    );

    // 作废前 occupied = 200。
    let ledger = await getProjectLedger(project.id, 2026, adminUser());
    expect(ledger.nodes.find((n) => n.subjectId === leafA.id)!.totalOccupied).toBe('200.00');

    const voided = await voidRecord(record.id, '登记错误', adminUser());
    expect(voided.isVoid).toBe(true);
    expect(voided.voidReason).toBe('登记错误');
    expect(voided.voidedBy).toBe(adminId);
    expect(voided.voidedAt).not.toBeNull();

    // §8.6 实时解除:ledger occupied 回到 0。
    ledger = await getProjectLedger(project.id, 2026, adminUser());
    expect(ledger.nodes.find((n) => n.subjectId === leafA.id)!.totalOccupied).toBe('0.00');

    // 不物理删除:行仍在,isVoid=true。
    const still = await prisma.businessRecord.findUnique({ where: { id: record.id } });
    expect(still).not.toBeNull();
    expect(still!.isVoid).toBe(true);

    // history 写入 action='void'。
    const hist = await prisma.businessRecordHistory.findFirst({
      where: { businessRecordId: record.id, action: 'void' },
    });
    expect(hist).not.toBeNull();
    expect(hist!.reason).toBe('登记错误');

    // 重复作废 → 409。
    await expect(voidRecord(record.id, '再次', adminUser())).rejects.toMatchObject({
      status: 409,
    });
  });

  it('updateRecord: 改科目 A→B,A 占用减少、B 占用增加;写 history', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('MOVESUB');

    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '150.00',
        businessDate: '2026-06-04',
        handler: '经办人A',
        summary: '待迁移',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );

    // 改前:A=150,B=0。
    let ledger = await getProjectLedger(project.id, 2026, adminUser());
    expect(ledger.nodes.find((n) => n.subjectId === leafA.id)!.totalOccupied).toBe('150.00');
    expect(ledger.nodes.find((n) => n.subjectId === leafB.id)!.totalOccupied).toBe('0.00');

    const { record: updated, overBudget } = await updateRecord(
      record.id,
      { subjectId: leafB.id },
      adminUser(),
    );

    expect(updated.subjectId).toBe(leafB.id);
    // B 预算 400,150 不超 → false。
    expect(overBudget).toBe(false);

    // §8.5 占用自动重算(实时聚合):A=0,B=150。
    ledger = await getProjectLedger(project.id, 2026, adminUser());
    expect(ledger.nodes.find((n) => n.subjectId === leafA.id)!.totalOccupied).toBe('0.00');
    expect(ledger.nodes.find((n) => n.subjectId === leafB.id)!.totalOccupied).toBe('150.00');

    // history update 留痕。
    const hist = await prisma.businessRecordHistory.findFirst({
      where: { businessRecordId: record.id, action: 'update' },
    });
    expect(hist).not.toBeNull();
  });

  it('updateRecord: 改金额触发超预算预警(B=400,改到 500 → overBudget=true)', async () => {
    const { project, leafB } = await seedApprovedProject('UPDOVER');

    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafB.id,
        amount: '100.00',
        businessDate: '2026-06-05',
        handler: '经办人A',
        summary: 'x',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );

    const { overBudget } = await updateRecord(record.id, { amount: '500.00' }, adminUser());
    // B 当前预算 400,500 > 400 → 超预算预警(仍保存)。
    expect(overBudget).toBe(true);

    const still = await prisma.businessRecord.findUnique({ where: { id: record.id } });
    expect(still!.amount.toFixed(2)).toBe('500.00');
  });

  it('switchStatus: 四态切换,写 history(action=status_switch)', async () => {
    const { project, leafA } = await seedApprovedProject('SWITCH');

    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '100.00',
        businessDate: '2026-06-06',
        handler: '经办人A',
        summary: 'x',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );

    const switched = await switchStatus(record.id, BusinessStatus.PAID, adminUser());
    expect(switched.status).toBe(BusinessStatus.PAID);

    // ledger:PLACEHOLDER→PAID,totalOccupied 不变(都是占用),但 paid=100,payable=0。
    const ledger = await getProjectLedger(project.id, 2026, adminUser());
    const nodeA = ledger.nodes.find((n) => n.subjectId === leafA.id)!;
    expect(nodeA.paid).toBe('100.00');
    expect(nodeA.payable).toBe('0.00');
    expect(nodeA.totalOccupied).toBe('100.00');

    // history。
    const hist = await prisma.businessRecordHistory.findFirst({
      where: { businessRecordId: record.id, action: 'status_switch' },
    });
    expect(hist).not.toBeNull();
  });

  it('listRecords: 组合筛选 + 默认排除作废', async () => {
    const { project, leafA, leafB } = await seedApprovedProject('LIST');

    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '50.00',
        businessDate: '2026-06-07',
        handler: '经办人A',
        summary: 'A1',
        status: BusinessStatus.PLACEHOLDER,
      },
      adminUser(),
    );
    const b1 = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafB.id,
        amount: '60.00',
        businessDate: '2026-06-08',
        handler: '经办人B',
        summary: 'B1',
        status: BusinessStatus.CONTRACT,
      },
      adminUser(),
    );
    await voidRecord(b1.record.id, '作废B1', adminUser());

    // 默认排除作废 → 只剩 A1。
    const all = await listRecords(project.id, {}, adminUser());
    expect(all.length).toBe(1);
    expect(all[0].summary).toBe('A1');

    // includeVoid → 2 条。
    const withVoid = await listRecords(project.id, { includeVoid: true }, adminUser());
    expect(withVoid.length).toBe(2);

    // 按 subjectId 筛选。
    const onlyA = await listRecords(project.id, { subjectId: leafA.id }, adminUser());
    expect(onlyA.length).toBe(1);
    expect(onlyA[0].subjectId).toBe(leafA.id);

    // 按 status 筛选(CONTRACT,B1 已作废被默认排除 → 0 条)。
    const contract = await listRecords(
      project.id,
      { status: BusinessStatus.CONTRACT },
      adminUser(),
    );
    expect(contract.length).toBe(0);
  });

  it('listRecords 扩展筛选:handler/summary 包含匹配 + 业务日期范围', async () => {
    const { project, leafA } = await seedApprovedProject('FILTER');

    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '10.00',
        businessDate: '2026-03-05',
        handler: '张三',
        summary: '采购实验材料',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );
    await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: leafA.id,
        amount: '20.00',
        businessDate: '2026-06-20',
        handler: '李四',
        summary: '差旅报销',
        status: BusinessStatus.PAID,
      },
      adminUser(),
    );

    // handler 包含匹配(忽略大小写)。
    const byZhang = await listRecords(project.id, { handler: '张' }, adminUser());
    expect(byZhang.length).toBe(1);
    expect(byZhang[0].handler).toBe('张三');

    // summary 关键词包含匹配。
    const bySummary = await listRecords(project.id, { summary: '材料' }, adminUser());
    expect(bySummary.length).toBe(1);
    expect(bySummary[0].summary).toBe('采购实验材料');

    // 日期闭区间:仅 3 月。
    const march = await listRecords(
      project.id,
      { businessDateFrom: '2026-03-01', businessDateTo: '2026-03-31' },
      adminUser(),
    );
    expect(march.length).toBe(1);
    expect(march[0].handler).toBe('张三');

    // 仅下界:两条都 ≥ 2026-03-01;仅上界到 3 月底 → 1 条。
    const fromMarch = await listRecords(
      project.id,
      { businessDateFrom: '2026-03-01' },
      adminUser(),
    );
    expect(fromMarch.length).toBe(2);
    const toMarch = await listRecords(project.id, { businessDateTo: '2026-03-31' }, adminUser());
    expect(toMarch.length).toBe(1);

    // 组合:handler + 日期范围 → 0 条(李四在 6 月)。
    const combo = await listRecords(
      project.id,
      { handler: '李四', businessDateFrom: '2026-03-01', businessDateTo: '2026-03-31' },
      adminUser(),
    );
    expect(combo.length).toBe(0);
  });
});

/**
 * 批量作废(voidRecordsBatch)独立用例:最小夹具(项目+叶科目+3 条记录),
 * 不走初始预算编制流程(超预算允许,createRecord 只要求叶科目)。
 */
describe('businessRecord.service voidRecordsBatch (integration, real PG)', () => {
  let adminId: string;
  let outsiderId: string;
  let projectId: string;
  let leafId: string;
  const recordIds: string[] = [];
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'admin-batchvoid', role: UserRole.ADMIN },
        { id: outsiderId, name: 'outsider-batchvoid', role: UserRole.USER },
      ],
    });
    const project = await createProject(
      { code: `BV-${uuidv7().slice(0, 8)}`, name: '批量作废测试' },
      adminUser(),
    );
    projectId = project.id;
    leafId = uuidv7();
    await prisma.budgetSubject.create({
      data: {
        id: leafId,
        projectId,
        parentId: null,
        code: 'L1',
        name: '叶科目',
        level: 1,
        isLeaf: true,
      },
    });
    for (const i of [1, 2, 3]) {
      const { record } = await createRecord(
        projectId,
        {
          budgetYear: 2026,
          subjectId: leafId,
          amount: `${i}0.00`,
          businessDate: '2026-08-01',
          handler: '经办',
          summary: `批量作废记录${i}`,
          status: BusinessStatus.PAID,
        },
        adminUser(),
      );
      recordIds.push(record.id);
    }
  });

  afterAll(async () => {
    await prisma.businessRecordHistory
      .deleteMany({ where: { businessRecord: { projectId } } })
      .catch(() => {});
    await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
    await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
    await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
    await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [adminId, outsiderId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('无成员资格的普通用户 → 403;空原因/空 id 列表 → 422', async () => {
    await expect(
      voidRecordsBatch(projectId, recordIds.slice(0, 1), '原因', {
        id: outsiderId,
        role: UserRole.USER,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      voidRecordsBatch(projectId, recordIds.slice(0, 1), '  ', adminUser()),
    ).rejects.toMatchObject({ status: 422 });
    await expect(voidRecordsBatch(projectId, [], '原因', adminUser())).rejects.toMatchObject({
      status: 422,
    });
  });

  it('批量作废:2 条生效;再跑一遍全部跳过;history/审计逐条留痕', async () => {
    // 预先作废第 3 条(模拟已作废行)。
    await voidRecord(recordIds[2], '单独作废', adminUser());

    const res = await voidRecordsBatch(projectId, recordIds, '集中清理', adminUser());
    expect(res).toEqual({ voided: 2, skipped: 1 });

    const rows = await prisma.businessRecord.findMany({
      where: { id: { in: recordIds } },
    });
    expect(rows.every((r) => r.isVoid)).toBe(true);
    expect(rows.every((r) => r.voidReason === '集中清理' || r.voidReason === '单独作废')).toBe(
      true,
    );

    // history:批量 2 条 + 单独 1 条 = 3 条 void。
    const history = await prisma.businessRecordHistory.findMany({
      where: { businessRecordId: { in: recordIds }, action: 'void' },
    });
    expect(history).toHaveLength(3);
    // 审计 void 3 条。
    const audits = await prisma.auditLog.findMany({
      where: { projectId, objectType: 'business_records', action: 'void' },
    });
    expect(audits).toHaveLength(3);

    // 再跑一遍:全部已作废 → voided 0 / skipped 3(不算失败)。
    const again = await voidRecordsBatch(projectId, recordIds, '重复操作', adminUser());
    expect(again).toEqual({ voided: 0, skipped: 3 });
  });

  it('全部 id 无效(跨项目/不存在)→ 404', async () => {
    await expect(
      voidRecordsBatch(projectId, [uuidv7(), uuidv7()], '原因', adminUser()),
    ).rejects.toMatchObject({ status: 404 });
  });
});
