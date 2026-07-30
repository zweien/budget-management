import {
  AdjustmentType,
  ApprovalStatus,
  BudgetAdjustment,
  LevelType,
  LineDirection,
  Prisma,
  User,
} from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, sumAmounts, toStored } from '@/lib/decimal';
import { adjustableAmount, computeOccupancy } from '@/lib/budget';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';

/** §7 调整单类型枚举集合。 */
const ADJUSTMENT_TYPES = new Set<string>(Object.values(AdjustmentType));
const LEVEL_TYPES = new Set<string>(Object.values(LevelType));
const LINE_DIRECTIONS = new Set<string>(Object.values(LineDirection));

/** §7 调整明细行入参(来自 payload)。 */
export interface AdjustmentLineInput {
  levelType: LevelType;
  year?: number | null;
  subjectId?: string | null;
  direction: LineDirection;
  amount: string; // decimal 字符串
}

/** §7 创建/编辑调整单 payload。 */
export interface AdjustmentPayload {
  type: AdjustmentType;
  reason?: string | null;
  lines: AdjustmentLineInput[];
}

/** 把 BudgetAdjustment 行序列化为快照对象(用于审计)。 */
function snapshotAdjustment(row: BudgetAdjustment): Record<string, unknown> {
  return snapshotRow({
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    status: row.status,
    reason: row.reason,
    applicantId: row.applicantId,
    approverId: row.approverId,
  });
}

/** 校验年度为正整数(1900~9999)。 */
function assertValidYear(year: number, label = 'year'): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new HTTPError(422, `${label} 必须是 1900~9999 的正整数`);
  }
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
    throw new HTTPError(422, '金额必须大于 0');
  }
  return d;
}

/**
 * 校验 subjectId 属于该项目且为叶节点(否则 422)。
 * 返回 BudgetSubject 行(含 code/isLeaf)。
 */
async function requireLeafSubject(
  tx: Prisma.TransactionClient | typeof prisma,
  projectId: string,
  subjectId: string,
): Promise<{ id: string; code: string; isLeaf: boolean }> {
  const subject = await tx.budgetSubject.findUnique({ where: { id: subjectId } });
  if (!subject || subject.projectId !== projectId) {
    throw new HTTPError(422, `科目 ${subjectId} 不属于该项目`);
  }
  if (!subject.isLeaf) {
    throw new HTTPError(422, `科目 ${subject.code} 不是叶节点,调整明细只能落在叶科目`);
  }
  return subject;
}

/**
 * §7.1 校验单个调整明细行的合法性与字段一致性。
 * - amount > 0(转 Decimal 返回)。
 * - SUBJECT / SUBJECT_TRANSFER 类型:必须 levelType=SUBJECT、必填 year、必填 subjectId(叶)。
 * - ANNUAL 类型:levelType=ANNUAL、必填 year、不得填 subjectId。
 * - PROJECT_TOTAL 类型:levelType=PROJECT、不得填 year、不得填 subjectId。
 *
 * 返回 { amount: Decimal }。subjectId 叶校验由调用方在事务内完成(需要 tx)。
 */
function validateLine(type: AdjustmentType, line: AdjustmentLineInput, index: number): D {
  if (!LEVEL_TYPES.has(line.levelType)) {
    throw new HTTPError(422, `第 ${index + 1} 行 levelType 非法:${line.levelType}`);
  }
  if (!LINE_DIRECTIONS.has(line.direction)) {
    throw new HTTPError(422, `第 ${index + 1} 行 direction 非法:${line.direction}`);
  }
  const amount = parsePositiveAmount(line.amount);

  const expectLevel: Record<AdjustmentType, LevelType> = {
    [AdjustmentType.PROJECT_TOTAL]: LevelType.PROJECT,
    [AdjustmentType.ANNUAL]: LevelType.ANNUAL,
    [AdjustmentType.SUBJECT]: LevelType.SUBJECT,
    [AdjustmentType.SUBJECT_TRANSFER]: LevelType.SUBJECT,
  };
  const want = expectLevel[type];
  if (line.levelType !== want) {
    throw new HTTPError(
      422,
      `第 ${index + 1} 行 levelType=${line.levelType} 与调整类型 ${type}(应为 ${want})不一致`,
    );
  }

  if (type === AdjustmentType.SUBJECT || type === AdjustmentType.SUBJECT_TRANSFER) {
    if (line.year === null || line.year === undefined) {
      throw new HTTPError(422, `第 ${index + 1} 行缺少 year(科目级调整必填年度)`);
    }
    assertValidYear(line.year, `第 ${index + 1} 行 year`);
    if (!line.subjectId) {
      throw new HTTPError(422, `第 ${index + 1} 行缺少 subjectId(科目级调整必填科目)`);
    }
  } else if (type === AdjustmentType.ANNUAL) {
    if (line.year === null || line.year === undefined) {
      throw new HTTPError(422, `第 ${index + 1} 行缺少 year(年度调整必填年度)`);
    }
    assertValidYear(line.year, `第 ${index + 1} 行 year`);
    if (line.subjectId) {
      throw new HTTPError(422, `第 ${index + 1} 行不得填写 subjectId(年度调整不带科目)`);
    }
  } else {
    // PROJECT_TOTAL
    if (line.year !== null && line.year !== undefined) {
      throw new HTTPError(422, `第 ${index + 1} 行不得填写 year(项目总额调整不带年度)`);
    }
    if (line.subjectId) {
      throw new HTTPError(422, `第 ${index + 1} 行不得填写 subjectId(项目总额调整不带科目)`);
    }
  }

  return amount;
}

/**
 * §7.1 SUBJECT_TRANSFER 调剂两端金额必须平衡(调增合计 == 调减合计)。
 * 其他类型无此约束(单边即可)。
 */
function assertTransferBalanced(
  type: AdjustmentType,
  amounts: { direction: LineDirection; amount: D }[],
): void {
  if (type !== AdjustmentType.SUBJECT_TRANSFER) return;
  const inc = sumAmounts(
    amounts.filter((a) => a.direction === LineDirection.INCREASE).map((a) => a.amount),
  );
  const dec = sumAmounts(
    amounts.filter((a) => a.direction === LineDirection.DECREASE).map((a) => a.amount),
  );
  if (!inc.eq(dec)) {
    throw new HTTPError(
      422,
      `科目调剂两端金额不平衡(调增 ${inc.toFixed(2)} ≠ 调减 ${dec.toFixed(2)}),§7.1 年度内部调增和调减必须金额平衡`,
    );
  }
  if (inc.lte(ZERO)) {
    throw new HTTPError(422, '科目调剂必须同时包含调增与调减明细');
  }
}

/**
 * §7 草稿创建调整单:createAdjustment。
 * - 权限:budget:adjust + 项目范围(§2.2)。
 * - 校验:每行 levelType/direction/year/subjectId 与 type 一致;amount > 0;
 *   SUBJECT/SUBJECT_TRANSFER 行的 subjectId 必须为该项目叶节点;
 *   SUBJECT_TRANSFER 两端必须金额平衡(§7.1)。
 * - 落库:adjustment(DRAFT)+ lines + 审计 create。
 * - 不写 budget_locks(锁定在 submitAdjustment 时按 §7.4/7.5 落地)。
 */
export async function createAdjustment(
  projectId: string,
  payload: AdjustmentPayload,
  user: Pick<User, 'id' | 'role'>,
): Promise<BudgetAdjustment> {
  await requirePermission(user, 'budget:adjust', projectId);

  if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new HTTPError(422, '调整明细不能为空');
  }
  if (!ADJUSTMENT_TYPES.has(payload.type)) {
    throw new HTTPError(422, `调整类型非法:${payload.type}`);
  }

  // 行级基础校验 + 解析金额。
  const parsedLines = payload.lines.map((line, i) => ({
    ...line,
    amount: validateLine(payload.type, line, i),
  }));

  // SUBJECT_TRANSFER 平衡校验。
  assertTransferBalanced(
    payload.type,
    parsedLines.map((l) => ({ direction: l.direction, amount: l.amount })),
  );

  // 项目必须存在(避免悬空外键)。
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, archivedAt: true },
  });
  if (!project) {
    throw new HTTPError(404, '项目不存在');
  }
  if (project.archivedAt) {
    throw new HTTPError(409, '项目已归档,不可发起调整');
  }

  // SUBJECT/SUBJECT_TRANSFER 行的科目必须是该项目叶节点。
  for (const line of parsedLines) {
    if (line.subjectId) {
      await requireLeafSubject(prisma, projectId, line.subjectId);
    }
  }

  const id = uuidv7();
  const reason = payload.reason?.trim() ? payload.reason.trim() : null;

  return prisma.$transaction(async (tx) => {
    const created = await tx.budgetAdjustment.create({
      data: {
        id,
        projectId,
        type: payload.type,
        status: ApprovalStatus.DRAFT,
        reason,
        applicantId: user.id,
      },
    });

    // 落库明细行。
    for (const line of parsedLines) {
      await tx.budgetAdjustmentLine.create({
        data: {
          id: uuidv7(),
          adjustmentId: id,
          levelType: line.levelType,
          year: line.year ?? null,
          subjectId: line.subjectId ?? null,
          direction: line.direction,
          amount: toStored(line.amount),
        },
      });
    }

    await recordAudit(tx, {
      projectId,
      objectType: 'budget_adjustments',
      objectId: id,
      action: 'create',
      operatorId: user.id,
      after: snapshotAdjustment(created),
    });

    return created;
  });
}

/** 调整单 + 明细 + 锁的展开类型(getAdjustment / listAdjustments 返回)。 */
export type AdjustmentWithRelations = Prisma.BudgetAdjustmentGetPayload<{
  include: { lines: true; locks: true };
}>;

/** §7 列出调整单(包含明细 + 锁)。 */
export async function listAdjustments(
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<AdjustmentWithRelations[]> {
  await requirePermission(user, 'project:view', projectId);
  return prisma.budgetAdjustment.findMany({
    where: { projectId },
    include: { lines: true, locks: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** §7 取单个调整单(包含明细 + 锁)。不存在抛 404。 */
export async function getAdjustment(
  adjId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<AdjustmentWithRelations> {
  const adj = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    include: { lines: true, locks: true },
  });
  if (!adj) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'project:view', adj.projectId);
  return adj;
}

/** 取某叶科目某年度:已有待审批(未释放)锁的金额合计。 */
async function existingPendingLock(
  tx: Prisma.TransactionClient,
  projectId: string,
  year: number,
  subjectId: string,
): Promise<D> {
  const locks = await tx.budgetLock.findMany({
    where: { projectId, year, subjectId, releasedAt: null },
    select: { amount: true },
  });
  return sumAmounts(locks.map((l) => fromStored(l.amount)));
}

/**
 * §7.4 提交调整单(DRAFT→PENDING):落地 §7.4/7.5 调出锁。
 *
 * - 仅 DRAFT 可提交(否则 409)。
 * - SUBJECT/SUBJECT_TRANSFER 的 DECREASE 叶节点行:校验 line.amount ≤ 该科目可调额度
 *   (current_budget - 总占用);超出 → 422 "调出额度不足";并为每个 DECREASE 行写一条
 *   budget_lock(amount=line.amount, year, subjectId, releasedAt=null)。
 * - PROJECT_TOTAL 的 DECREASE:校验 (project_total_current - 总占用) ≥ line.amount,
 *   即项目总当前预算扣除业务占用后仍不跌破调减额;否则 422。不写叶节点锁(§7.4 颗粒度在科目)。
 * - ANNUAL 的 DECREASE:校验 (annual_current - 该年度业务占用) ≥ line.amount;否则 422。
 *   不写叶节点锁。
 * - INCREASE 行不锁定(§7.5 待审批调入金额不可提前使用)。
 * - 事务内写完锁后置 status=PENDING,审计 submit。
 */
export async function submitAdjustment(
  adjId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<BudgetAdjustment> {
  const adj = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    include: { lines: true },
  });
  if (!adj) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:adjust', adj.projectId);

  if (adj.status !== ApprovalStatus.DRAFT) {
    throw new HTTPError(409, `当前状态 ${adj.status} 不可提交,仅 DRAFT 可提交`);
  }

  // 按 levelType 分组收集 DECREASE 金额(校验 + 锁定用)。
  // 把同一 (year, subjectId) 的多条 DECREASE 行金额合并。
  const decreaseSubjectLines = new Map<string, { year: number; subjectId: string; amount: D }>();
  const annualDecreaseByYear = new Map<number, D>();
  const ptDecrease = sumAmounts(
    adj.lines
      .filter((l) => l.levelType === LevelType.PROJECT && l.direction === LineDirection.DECREASE)
      .map((l) => fromStored(l.amount)),
  );
  for (const line of adj.lines) {
    if (line.direction !== LineDirection.DECREASE) continue;
    if (line.levelType === LevelType.SUBJECT) {
      // SUBJECT / SUBJECT_TRANSFER 叶节点行。
      if (line.year === null || line.year === undefined || !line.subjectId) {
        throw new HTTPError(422, '科目级调减明细缺少 year/subjectId');
      }
      const key = `${line.year}:${line.subjectId}`;
      const prev = decreaseSubjectLines.get(key);
      const add = fromStored(line.amount);
      decreaseSubjectLines.set(key, {
        year: line.year,
        subjectId: line.subjectId,
        amount: prev ? prev.amount.plus(add) : add,
      });
    } else if (line.levelType === LevelType.ANNUAL) {
      if (line.year === null || line.year === undefined) {
        throw new HTTPError(422, '年度调减明细缺少 year');
      }
      annualDecreaseByYear.set(
        line.year,
        (annualDecreaseByYear.get(line.year) ?? ZERO).plus(fromStored(line.amount)),
      );
    }
    // LevelType.PROJECT 已在 ptDecrease 收集。
  }

  return prisma.$transaction(async (tx) => {
    // ① SUBJECT 级 DECREASE:校验可调额度 + 写叶节点锁。
    for (const [, info] of decreaseSubjectLines) {
      const [subjectBudget, records] = await Promise.all([
        tx.subjectBudget.findUnique({
          where: {
            projectId_year_subjectId: {
              projectId: adj.projectId,
              year: info.year,
              subjectId: info.subjectId,
            },
          },
        }),
        tx.businessRecord.findMany({
          where: {
            projectId: adj.projectId,
            budgetYear: info.year,
            subjectId: info.subjectId,
            isVoid: false,
          },
          select: { amount: true, status: true, isVoid: true },
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
      // §7.4 可调额度 = current - 占用(不含尚未提交的本次锁;在 create 阶段无锁,故直接用 adjustableAmount)。
      const adjustable = adjustableAmount(currentBudget, occ.totalOccupied);
      if (info.amount.gt(adjustable)) {
        throw new HTTPError(
          422,
          `调出额度不足:科目 ${info.subjectId} 可调额度 ${adjustable.toFixed(2)},本次调减 ${info.amount.toFixed(2)}`,
        );
      }
      // 已有待审批锁则叠加上限(避免多张调减单累计超过可调额度)。
      const prevLock = await existingPendingLock(tx, adj.projectId, info.year, info.subjectId);
      if (prevLock.plus(info.amount).gt(adjustable)) {
        throw new HTTPError(
          422,
          `调出额度不足:科目 ${info.subjectId} 可调额度 ${adjustable.toFixed(2)},已有待审批锁 ${prevLock.toFixed(2)},本次再调减 ${info.amount.toFixed(2)} 将超额`,
        );
      }

      // §7.5 写叶节点锁(releasedAt=null;审批生效或驳回/撤回时释放,见 Task 4)。
      await tx.budgetLock.create({
        data: {
          id: uuidv7(),
          adjustmentId: adjId,
          projectId: adj.projectId,
          year: info.year,
          subjectId: info.subjectId,
          amount: toStored(info.amount),
          releasedAt: null,
        },
      });
    }

    // ② PROJECT_TOTAL DECREASE:项目总当前预算 - 项目总业务占用 ≥ 调减额;否则 422。
    if (ptDecrease.gt(ZERO)) {
      const projectBudget = await tx.projectBudget.findUnique({
        where: { projectId: adj.projectId },
      });
      if (!projectBudget) {
        throw new HTTPError(404, '项目预算记录不存在');
      }
      const projectCurrent = fromStored(projectBudget.currentAmount);
      const allRecords = await tx.businessRecord.findMany({
        where: { projectId: adj.projectId, isVoid: false },
        select: { amount: true, status: true, isVoid: true },
      });
      const projectOcc = computeOccupancy({
        records: allRecords.map((r) => ({ amount: r.amount, status: r.status, isVoid: r.isVoid })),
      });
      const adjustable = adjustableAmount(projectCurrent, projectOcc.totalOccupied);
      if (ptDecrease.gt(adjustable)) {
        throw new HTTPError(
          422,
          `项目总额可调额度不足:可调 ${adjustable.toFixed(2)},本次调减 ${ptDecrease.toFixed(2)}`,
        );
      }
      // §7.4 V1 决策:PROJECT_TOTAL 不写叶节点锁(颗粒度在科目)。
    }

    // ③ ANNUAL DECREASE:年度当前预算 - 该年度业务占用 ≥ 调减额;否则 422。
    for (const [year, decAmount] of annualDecreaseByYear.entries()) {
      const annualBudget = await tx.annualBudget.findUnique({
        where: { projectId_year: { projectId: adj.projectId, year } },
      });
      if (!annualBudget) {
        throw new HTTPError(422, `${year} 年度预算不存在,无法调整`);
      }
      const annualCurrent = fromStored(annualBudget.currentAmount);
      const yearRecords = await tx.businessRecord.findMany({
        where: { projectId: adj.projectId, budgetYear: year, isVoid: false },
        select: { amount: true, status: true, isVoid: true },
      });
      const yearOcc = computeOccupancy({
        records: yearRecords.map((r) => ({ amount: r.amount, status: r.status, isVoid: r.isVoid })),
      });
      const adjustable = adjustableAmount(annualCurrent, yearOcc.totalOccupied);
      if (decAmount.gt(adjustable)) {
        throw new HTTPError(
          422,
          `${year} 年度可调额度不足:可调 ${adjustable.toFixed(2)},本次调减 ${decAmount.toFixed(2)}`,
        );
      }
      // §7.4 V1 决策:ANNUAL 不写叶节点锁。
    }

    // ④ 状态 DRAFT→PENDING + 审计 submit。
    const now = new Date();
    const updated = await tx.budgetAdjustment.update({
      where: { id: adjId },
      data: { status: ApprovalStatus.PENDING },
    });
    await recordAudit(tx, {
      projectId: adj.projectId,
      objectType: 'budget_adjustments',
      objectId: adjId,
      action: 'submit',
      operatorId: user.id,
      before: snapshotAdjustment(adj),
      after: { ...snapshotAdjustment(updated), submittedAt: now.toISOString() },
    });

    return updated;
  });
}
