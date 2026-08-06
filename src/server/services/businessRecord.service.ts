import { BusinessStatus, BusinessRecord, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, toStored } from '@/lib/decimal';
import { computeOccupancy } from '@/lib/budget';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';

/** §8 四态枚举(便于上层校验集合)。 */
const BUSINESS_STATUSES: readonly BusinessStatus[] = [
  BusinessStatus.PLACEHOLDER,
  BusinessStatus.CONTRACT,
  BusinessStatus.FINANCE_APPROVAL,
  BusinessStatus.PAID,
] as const;

/** §8 新增业务记录入参(金额统一 decimal 字符串,§global 约定)。 */
export interface CreateRecordInput {
  budgetYear: number;
  subjectId: string;
  amount: string;
  businessDate: string; // ISO yyyy-mm-dd
  handler: string;
  summary: string;
  status: BusinessStatus;
  remark?: string | null;
}

/** §8.5 修改业务记录入参:全部字段可选。 */
export interface UpdateRecordInput {
  budgetYear?: number;
  subjectId?: string;
  amount?: string;
  businessDate?: string;
  handler?: string;
  summary?: string;
  status?: BusinessStatus;
  remark?: string | null;
}

/** §8 list 组合筛选参数。 */
export interface ListRecordsFilters {
  year?: number;
  subjectId?: string;
  status?: BusinessStatus;
  includeVoid?: boolean;
  /** 经办人(包含匹配,忽略大小写)。 */
  handler?: string;
  /** 摘要关键词(包含匹配,忽略大小写)。 */
  summary?: string;
  /** 业务发生日期范围(yyyy-mm-dd,闭区间)。 */
  businessDateFrom?: string;
  businessDateTo?: string;
}

/** §8.4 超预算预警的返回结构:createRecord 与 updateRecord 均带 overBudget 标志。 */
export interface RecordWithWarning {
  record: BusinessRecord;
  overBudget: boolean;
}

/** 把 BusinessRecord 行序列化为快照对象(用于 history before/after 与审计)。 */
function snapshotRecord(row: BusinessRecord): Record<string, unknown> {
  return snapshotRow({
    id: row.id,
    projectId: row.projectId,
    budgetYear: row.budgetYear,
    subjectId: row.subjectId,
    amount: row.amount,
    businessDate: row.businessDate,
    handler: row.handler,
    summary: row.summary,
    status: row.status,
    remark: row.remark,
    isVoid: row.isVoid,
    voidReason: row.voidReason,
    voidedBy: row.voidedBy,
    voidedAt: row.voidedAt,
  });
}

/** 校验年度为正整数(1900~9999)。 */
function assertValidYear(year: number, label = 'budgetYear'): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new HTTPError(422, `${label} 必须是 1900~9999 的正整数`);
  }
}

/** 校验金额字符串 > 0。 */
function parsePositiveAmount(amount: string): D {
  let d: D;
  try {
    d = new D(amount);
  } catch {
    throw new HTTPError(422, `金额格式无效:${amount}`);
  }
  if (!d.isFinite() || d.lte(ZERO)) {
    throw new HTTPError(422, '金额必须大于 0');
  }
  return d;
}

/** 校验 businessDate 字符串可解析为合法日期。 */
function parseBusinessDate(s: string): Date {
  // 仅接受 yyyy-mm-dd,避免时区漂移。
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    throw new HTTPError(422, `业务日期格式无效(应为 yyyy-mm-dd):${s}`);
  }
  const dt = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) {
    throw new HTTPError(422, `业务日期无效:${s}`);
  }
  return dt;
}

/**
 * §8.4 计算某年度某叶科目:在追加 `extraAmount` 的情况下是否超预算。
 * - currentBudget 来自 subject_budgets.currentAmount(审批生效后置位)。
 * - 现有占用走 computeOccupancy(已有非作废记录的实时聚合)。
 * - 超预算仍允许保存(§8.4),仅返回预警标志。
 *
 * 返回 { overBudget, currentBudget, projectedOccupied }。
 */
async function computeOverBudget(
  projectId: string,
  budgetYear: number,
  subjectId: string,
  extraAmount: D,
): Promise<{ overBudget: boolean; currentBudget: D; projectedOccupied: D }> {
  const [subjectBudget, records] = await Promise.all([
    prisma.subjectBudget.findUnique({
      where: { projectId_year_subjectId: { projectId, year: budgetYear, subjectId } },
    }),
    prisma.businessRecord.findMany({
      where: { projectId, budgetYear, subjectId, isVoid: false },
    }),
  ]);

  const currentBudget = subjectBudget ? fromStored(subjectBudget.currentAmount) : ZERO;
  const occ = computeOccupancy({
    records: records.map((r) => ({
      amount: r.amount,
      status: r.status,
      isVoid: r.isVoid,
    })),
  });
  const projectedOccupied = occ.totalOccupied.plus(extraAmount);
  // §8.4 现有占用 + 本次金额 > 当前预算 → 超预算预警(仍保存)。
  const overBudget = projectedOccupied.gt(currentBudget);
  return { overBudget, currentBudget, projectedOccupied };
}

/**
 * §8 校验 subjectId 属于该项目且为叶节点(否则 422)。
 * 返回 BudgetSubject 行。
 */
async function requireLeafSubject(
  tx: Prisma.TransactionClient | typeof prisma,
  projectId: string,
  subjectId: string,
): Promise<{ id: string; isLeaf: boolean }> {
  const subject = await tx.budgetSubject.findUnique({ where: { id: subjectId } });
  if (!subject || subject.projectId !== projectId) {
    throw new HTTPError(422, `科目 ${subjectId} 不属于该项目`);
  }
  if (!subject.isLeaf) {
    throw new HTTPError(422, `科目 ${subject.code} 不是叶节点,业务记录只能登记在叶科目`);
  }
  return subject;
}

/**
 * §8.1/8.4 新增业务记录。
 * - 权限:record:create + 项目范围。
 * - 校验:subjectId 为该项目叶节点;budgetYear 正整数;amount > 0;status 合法四态之一;
 *   businessDate 有效;handler/summary 非空。
 * - §8.4 超预算仍保存,仅返回 overBudget 标志。
 * - 事务内:写 business_record(id=uuidv7,createdById) + 审计 create。
 * - 返回 { record, overBudget }。
 */
export async function createRecord(
  projectId: string,
  input: CreateRecordInput,
  user: Pick<User, 'id' | 'role'>,
): Promise<RecordWithWarning> {
  await requirePermission(user, 'record:create', projectId);

  // 基础字段校验(在事务外做,失败即返回 422,无需占连接)。
  assertValidYear(input.budgetYear);
  const amount = parsePositiveAmount(input.amount);
  if (!BUSINESS_STATUSES.includes(input.status)) {
    throw new HTTPError(422, `状态非法,仅允许 ${BUSINESS_STATUSES.join('/')}`);
  }
  if (!input.status) {
    throw new HTTPError(422, '状态不能为空');
  }
  if (!input.handler || !input.handler.trim()) {
    throw new HTTPError(422, '经办人不能为空');
  }
  if (!input.summary || !input.summary.trim()) {
    throw new HTTPError(422, '摘要不能为空');
  }
  const businessDate = parseBusinessDate(input.businessDate);

  // 校验科目属于该项目且为叶节点。
  await requireLeafSubject(prisma, projectId, input.subjectId);

  // §8.4 超预算预警(在事务外读,不影响保存)。
  const { overBudget } = await computeOverBudget(
    projectId,
    input.budgetYear,
    input.subjectId,
    amount,
  );

  const id = uuidv7();
  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.businessRecord.create({
      data: {
        id,
        projectId,
        budgetYear: input.budgetYear,
        subjectId: input.subjectId,
        amount: toStored(amount),
        businessDate,
        handler: input.handler.trim(),
        summary: input.summary.trim(),
        status: input.status,
        remark: input.remark ?? null,
        isVoid: false,
        createdById: user.id,
      },
    });

    await recordAudit(tx, {
      projectId,
      objectType: 'business_records',
      objectId: created.id,
      action: 'create',
      operatorId: user.id,
      after: snapshotRecord(created),
    });

    return created;
  });

  return { record, overBudget };
}

/**
 * §8 列出业务记录(组合筛选)。
 * - 权限:project:view + 项目范围(查看记录归入"查看获授权项目",§2.2)。
 * - 默认不含作废(includeVoid=false)。
 */
export async function listRecords(
  projectId: string,
  filters: ListRecordsFilters,
  user: Pick<User, 'id' | 'role'>,
): Promise<BusinessRecord[]> {
  await requirePermission(user, 'project:view', projectId);

  const where: Prisma.BusinessRecordWhereInput = { projectId };
  if (filters.year !== undefined) {
    where.budgetYear = filters.year;
  }
  if (filters.subjectId) {
    where.subjectId = filters.subjectId;
  }
  if (filters.status) {
    where.status = filters.status;
  }
  if (!filters.includeVoid) {
    where.isVoid = false;
  }
  if (filters.handler) {
    where.handler = { contains: filters.handler, mode: 'insensitive' };
  }
  if (filters.summary) {
    where.summary = { contains: filters.summary, mode: 'insensitive' };
  }
  if (filters.businessDateFrom || filters.businessDateTo) {
    where.businessDate = {};
    if (filters.businessDateFrom) {
      where.businessDate.gte = parseBusinessDate(filters.businessDateFrom);
    }
    if (filters.businessDateTo) {
      where.businessDate.lte = parseBusinessDate(filters.businessDateTo);
    }
  }

  return prisma.businessRecord.findMany({
    where,
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * §8.5 修改业务记录。
 * - 权限:record:edit + 项目范围。
 * - 修改前后留痕:写一条 business_record_history(action:'update', before/after 快照)。
 * - 若改 subjectId:校验新 subjectId 仍是该项目叶节点;若改 budgetYear:校验年度有效。
 * - 占用由 ledger 实时聚合自然重算,此处不做手动重算。
 * - 审计 update。
 * - 返回 { record, overBudget }(overBudget 按新年度/新科目/新金额重算)。
 */
export async function updateRecord(
  recordId: string,
  input: UpdateRecordInput,
  user: Pick<User, 'id' | 'role'>,
): Promise<RecordWithWarning> {
  const before = await prisma.businessRecord.findUnique({ where: { id: recordId } });
  if (!before) {
    throw new HTTPError(404, '业务记录不存在');
  }
  await requirePermission(user, 'record:edit', before.projectId);

  // 计算生效后的新值(用于校验 + 超预算预警)。
  const newSubjectId = input.subjectId ?? before.subjectId;
  const newYear = input.budgetYear ?? before.budgetYear;
  const newAmountRaw = input.amount ?? before.amount.toFixed(2);
  const newStatus = input.status ?? before.status;

  // 校验。
  assertValidYear(newYear);
  if (!BUSINESS_STATUSES.includes(newStatus)) {
    throw new HTTPError(422, `状态非法,仅允许 ${BUSINESS_STATUSES.join('/')}`);
  }
  const amount = parsePositiveAmount(newAmountRaw);
  if (input.handler !== undefined && !input.handler.trim()) {
    throw new HTTPError(422, '经办人不能为空');
  }
  if (input.summary !== undefined && !input.summary.trim()) {
    throw new HTTPError(422, '摘要不能为空');
  }
  let newBusinessDate = before.businessDate;
  if (input.businessDate !== undefined) {
    newBusinessDate = parseBusinessDate(input.businessDate);
  }
  // 校验新科目属于该项目且为叶节点(若未改 subjectId,等价于校验原科目仍是叶节点)。
  await requireLeafSubject(prisma, before.projectId, newSubjectId);

  // §8.4 超预算预警(按"生效后值"计算;排除本条自身占用,因为本条会被改写)。
  const { overBudget } = await computeOverBudgetExcluding(
    before.projectId,
    newYear,
    newSubjectId,
    amount,
    recordId,
  );

  const data: Prisma.BusinessRecordUpdateInput = {
    budgetYear: newYear,
    subject: { connect: { id: newSubjectId } },
    amount: toStored(amount),
    businessDate: newBusinessDate,
    status: newStatus,
    modifiedBy: { connect: { id: user.id } },
  };
  if (input.handler !== undefined) data.handler = input.handler.trim();
  if (input.summary !== undefined) data.summary = input.summary.trim();
  if (input.remark !== undefined) data.remark = input.remark;

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.businessRecord.update({ where: { id: recordId }, data });

    // §8.5 history:before/after 整行快照。
    await tx.businessRecordHistory.create({
      data: {
        id: uuidv7(),
        businessRecordId: recordId,
        action: 'update',
        beforeData: snapshotRecord(before) as Prisma.InputJsonValue,
        afterData: snapshotRecord(updated) as Prisma.InputJsonValue,
        operatorId: user.id,
      },
    });

    await recordAudit(tx, {
      projectId: before.projectId,
      objectType: 'business_records',
      objectId: recordId,
      action: 'update',
      operatorId: user.id,
      before: snapshotRecord(before),
      after: snapshotRecord(updated),
    });

    return updated;
  });

  return { record: after, overBudget };
}

/** 计算超预算预警,但排除指定的某条记录(用于 update:本条将被改写,不再算旧占用)。 */
async function computeOverBudgetExcluding(
  projectId: string,
  budgetYear: number,
  subjectId: string,
  extraAmount: D,
  excludeRecordId: string,
): Promise<{ overBudget: boolean }> {
  const [subjectBudget, records] = await Promise.all([
    prisma.subjectBudget.findUnique({
      where: { projectId_year_subjectId: { projectId, year: budgetYear, subjectId } },
    }),
    prisma.businessRecord.findMany({
      where: { projectId, budgetYear, subjectId, isVoid: false },
    }),
  ]);
  const currentBudget = subjectBudget ? fromStored(subjectBudget.currentAmount) : ZERO;
  const others = records.filter((r) => r.id !== excludeRecordId);
  const occ = computeOccupancy({
    records: others.map((r) => ({ amount: r.amount, status: r.status, isVoid: r.isVoid })),
  });
  const projected = occ.totalOccupied.plus(extraAmount);
  return { overBudget: projected.gt(currentBudget) };
}

/**
 * §8.6 作废业务记录。
 * - 权限:record:void + 项目范围。
 * - 置 isVoid=true, voidReason, voidedBy, voidedAt;占用由 ledger 实时聚合自然解除(不手动重算)。
 * - history 行(action:'void');审计 void。
 * - 不得物理删除。重复作废 → 409。
 */
export async function voidRecord(
  recordId: string,
  reason: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<BusinessRecord> {
  const before = await prisma.businessRecord.findUnique({ where: { id: recordId } });
  if (!before) {
    throw new HTTPError(404, '业务记录不存在');
  }
  await requirePermission(user, 'record:void', before.projectId);

  if (before.isVoid) {
    throw new HTTPError(409, '该记录已作废,不可重复作废');
  }
  if (!reason || !reason.trim()) {
    throw new HTTPError(422, '作废原因不能为空');
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const after = await tx.businessRecord.update({
      where: { id: recordId },
      data: {
        isVoid: true,
        voidReason: reason.trim(),
        voidedBy: user.id,
        voidedAt: now,
        modifiedBy: { connect: { id: user.id } },
      },
    });

    await tx.businessRecordHistory.create({
      data: {
        id: uuidv7(),
        businessRecordId: recordId,
        action: 'void',
        beforeData: snapshotRecord(before) as Prisma.InputJsonValue,
        afterData: snapshotRecord(after) as Prisma.InputJsonValue,
        operatorId: user.id,
        reason: reason.trim(),
      },
    });

    await recordAudit(tx, {
      projectId: before.projectId,
      objectType: 'business_records',
      objectId: recordId,
      action: 'void',
      operatorId: user.id,
      before: snapshotRecord(before),
      after: snapshotRecord(after),
    });

    return after;
  });
}

/**
 * §8.3 四态自由切换。
 * - 权限:record:edit + 项目范围。
 * - history 行(action:'status_switch');审计 status_switch。
 */
export async function switchStatus(
  recordId: string,
  newStatus: BusinessStatus,
  user: Pick<User, 'id' | 'role'>,
): Promise<BusinessRecord> {
  const before = await prisma.businessRecord.findUnique({ where: { id: recordId } });
  if (!before) {
    throw new HTTPError(404, '业务记录不存在');
  }
  await requirePermission(user, 'record:edit', before.projectId);

  if (!BUSINESS_STATUSES.includes(newStatus)) {
    throw new HTTPError(422, `状态非法,仅允许 ${BUSINESS_STATUSES.join('/')}`);
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.businessRecord.update({
      where: { id: recordId },
      data: { status: newStatus, modifiedBy: { connect: { id: user.id } } },
    });

    await tx.businessRecordHistory.create({
      data: {
        id: uuidv7(),
        businessRecordId: recordId,
        action: 'status_switch',
        beforeData: snapshotRecord(before) as Prisma.InputJsonValue,
        afterData: snapshotRecord(after) as Prisma.InputJsonValue,
        operatorId: user.id,
      },
    });

    await recordAudit(tx, {
      projectId: before.projectId,
      objectType: 'business_records',
      objectId: recordId,
      action: 'status_switch',
      operatorId: user.id,
      before: { status: before.status },
      after: { status: newStatus },
    });

    return after;
  });
}
