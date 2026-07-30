import { Prisma, ReceiptRecord, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, sumAmounts, toStored } from '@/lib/decimal';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';

/**
 * §9 到账流水(ReceiptRecord)。到账仅作参考登记,不参与预算上限校验
 * (§9.1:到账不是预算 cap),因此本服务不与 occupancy/budget 交互,
 * 仅提供 CRUD + 累计金额(用于页面展示)。
 *
 * 权限:到账属"业务维护"(§2.2),沿用 record:create / record:edit / project:view。
 */

/** §9 到账列表返回:记录 + 到账累计(全部记录金额之和)。 */
export interface ReceiptListResult {
  records: ReceiptWithCreator[];
  /** 到账累计(2 位小数字符串)。 */
  cumulative: string;
}

/** 到账记录 + 录入人名称(join User,用于页面展示"录入人")。 */
export type ReceiptWithCreator = Prisma.ReceiptRecordGetPayload<{
  include: { creator: { select: { id: true; name: true } } };
}>;

/** §9 新增到账入参。 */
export interface CreateReceiptInput {
  /** 到账日期(ISO yyyy-mm-dd)。 */
  receiptDate: string;
  /** 到账金额(字符串,§5 字符串传输),必须 > 0。 */
  amount: string;
  /** 摘要(可选)。 */
  summary?: string | null;
  /** 备注(可选)。 */
  remark?: string | null;
}

/** §9 修改到账入参(全部字段可选)。 */
export interface UpdateReceiptInput {
  receiptDate?: string;
  amount?: string;
  summary?: string | null;
  remark?: string | null;
}

/** 把 ReceiptRecord 行序列化为快照对象(用于审计 before/after)。 */
function snapshotReceipt(row: ReceiptRecord): Record<string, unknown> {
  return snapshotRow({
    id: row.id,
    projectId: row.projectId,
    receiptDate: row.receiptDate,
    amount: row.amount,
    summary: row.summary,
    remark: row.remark,
    creatorId: row.creatorId,
    createdAt: row.createdAt,
  });
}

/** 校验金额字符串 > 0,返回领域 Decimal。 */
function parsePositiveAmount(amount: string): D {
  let d: D;
  try {
    d = new D(amount);
  } catch {
    throw new HTTPError(422, `金额格式无效:${amount}`);
  }
  if (!d.isFinite() || d.lte(ZERO)) {
    throw new HTTPError(422, '到账金额必须大于 0');
  }
  return d;
}

/** 校验 receiptDate 字符串可解析为合法日期(yyyy-mm-dd,避免时区漂移)。 */
function parseReceiptDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    throw new HTTPError(422, `到账日期格式无效(应为 yyyy-mm-dd):${s}`);
  }
  const dt = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) {
    throw new HTTPError(422, `到账日期无效:${s}`);
  }
  return dt;
}

/**
 * §9.1 新增到账记录。
 * - 权限:record:create + 项目范围(到账属业务维护,§2.2)。
 * - 校验:amount > 0;receiptDate 可解析。
 * - 到账不参与预算上限,故不做 occupancy/超预算判定。
 * - 事务内:写 receipt_records(id=uuidv7, creatorId) + 审计 create。
 */
export async function createReceipt(
  projectId: string,
  input: CreateReceiptInput,
  user: Pick<User, 'id' | 'role'>,
): Promise<ReceiptRecord> {
  await requirePermission(user, 'record:create', projectId);

  const amount = parsePositiveAmount(input.amount);
  const receiptDate = parseReceiptDate(input.receiptDate);

  const id = uuidv7();
  return prisma.$transaction(async (tx) => {
    const created = await tx.receiptRecord.create({
      data: {
        id,
        projectId,
        receiptDate,
        amount: toStored(amount),
        summary: input.summary?.trim() ? input.summary.trim() : null,
        remark: input.remark?.trim() ? input.remark.trim() : null,
        creatorId: user.id,
      },
    });

    await recordAudit(tx, {
      projectId,
      objectType: 'receipt_records',
      objectId: created.id,
      action: 'create',
      operatorId: user.id,
      after: snapshotReceipt(created),
    });

    return created;
  });
}

/**
 * §9 列出到账记录 + 到账累计。
 * - 权限:project:view + 项目范围。
 * - 累计 = 全部记录金额之和(到账不区分年度/状态,统一求和)。
 * - 返回 { records, cumulative }。
 */
export async function listReceipts(
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<ReceiptListResult> {
  await requirePermission(user, 'project:view', projectId);

  const records = await prisma.receiptRecord.findMany({
    where: { projectId },
    orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }],
    include: { creator: { select: { id: true, name: true } } },
  });

  const cumulative = sumAmounts(records.map((r) => fromStored(r.amount)));
  return { records, cumulative: cumulative.toFixed(2) };
}

/**
 * §9 修改到账记录。
 * - 权限:record:edit + 项目范围(到账属业务维护,§2.2)。
 * - 记录不存在 → 404。
 * - 校验生效后的 amount/receiptDate(若提供)。
 * - 事务内:update + 审计 update(before/after 整行快照)。
 */
export async function updateReceipt(
  receiptId: string,
  input: UpdateReceiptInput,
  user: Pick<User, 'id' | 'role'>,
): Promise<ReceiptRecord> {
  const before = await prisma.receiptRecord.findUnique({ where: { id: receiptId } });
  if (!before) {
    throw new HTTPError(404, '到账记录不存在');
  }
  await requirePermission(user, 'record:edit', before.projectId);

  const data: Prisma.ReceiptRecordUpdateInput = {};
  if (input.amount !== undefined) {
    const amount = parsePositiveAmount(input.amount);
    data.amount = toStored(amount);
  }
  if (input.receiptDate !== undefined) {
    data.receiptDate = parseReceiptDate(input.receiptDate);
  }
  if (input.summary !== undefined) {
    data.summary = input.summary?.trim() ? input.summary.trim() : null;
  }
  if (input.remark !== undefined) {
    data.remark = input.remark?.trim() ? input.remark.trim() : null;
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.receiptRecord.update({ where: { id: receiptId }, data });

    await recordAudit(tx, {
      projectId: before.projectId,
      objectType: 'receipt_records',
      objectId: receiptId,
      action: 'update',
      operatorId: user.id,
      before: snapshotReceipt(before),
      after: snapshotReceipt(updated),
    });

    return updated;
  });
}

/**
 * §9 删除到账记录(物理删除)。
 * 到账为参考数据,§9 允许修改/删除;不像业务记录有强审计链要求,
 * 但为安全起见仍保留一条 delete 审计日志(before 快照)。
 *
 * - 权限:record:edit + 项目范围(删除归入到账业务维护)。
 * - 记录不存在 → 404。
 * - 物理删除行;事务内先记审计,再删行。
 */
export async function deleteReceipt(
  receiptId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
  const before = await prisma.receiptRecord.findUnique({ where: { id: receiptId } });
  if (!before) {
    throw new HTTPError(404, '到账记录不存在');
  }
  await requirePermission(user, 'record:edit', before.projectId);

  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, {
      projectId: before.projectId,
      objectType: 'receipt_records',
      objectId: receiptId,
      action: 'delete',
      operatorId: user.id,
      before: snapshotReceipt(before),
    });
    await tx.receiptRecord.delete({ where: { id: receiptId } });
  });
}
