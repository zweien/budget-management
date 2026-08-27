import { AdjustmentKind, ApprovalStatus, BudgetAdjustment, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, sumAmounts, toStored } from '@/lib/decimal';
import { adjustableAmount, computeOccupancy } from '@/lib/budget';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';

/**
 * §7 预算调整(双维度模型 + 追加下达模式)。
 *
 * kind=ADJUST(调剂,默认) —— 零和挪钱:
 * - 总预算维度(totalAdjustment)/年度预算维度(annualAdjustment)各自 Σ === 0。
 * - 提交时对年度调减行校验可调额度并写 budget_lock;审批生效后双维度同步更新。
 *
 * kind=ALLOCATE(追加下达) —— 净增做预算("总盘子固定、年度分批做满",含新经费入账):
 * - 每行只有年度维度下达额(annualAdjustment ≥ 0,totalAdjustment 必须 0),Σ > 0。
 * - 目标年份未建账则审批生效时自动创建 AnnualBudget 与各行 SubjectBudget。
 * - 护栏:现有科目行的分配额 ≤ 该科目总预算 − 历年已分配年度预算合计(剩余可分配额);
 *   新增科目行无此限制(首笔分配即立账)。
 * - 生效联动:AnnualBudget(该年) 新建或累加 += X;ProjectBudget.currentAmount += X;
 *   SubjectTotalBudget 不动(总额在编制时已定,追加分批落地到年份);
 *   新增科目行的总预算以首笔分配额立账。
 */

/** 单行入参(来自 payload)。 */
export interface AdjustmentLineInput {
  // 引用现有科目;新增科目时省略(填 newSubjectName/newSubjectParentId)。
  subjectId?: string | null;
  // 新增科目(仅 subjectId 为空时):名称 + 父节点(非叶科目 id)。
  newSubjectName?: string | null;
  newSubjectParentId?: string | null;
  // ALLOCATE 模式下必须为 0(或省略,按 0 处理)。
  totalAdjustment: string; // decimal 字符串,可正可负
  annualAdjustment: string; // decimal 字符串,可正可负
}

/** 创建/编辑调整单 payload。 */
export interface AdjustmentPayload {
  year: number;
  /** 调整单类型,缺省 ADJUST(调剂)。 */
  kind?: 'ADJUST' | 'ALLOCATE';
  /**
   * 仅 ALLOCATE:追加的同时调增科目总预算与项目总预算(新经费入账)。
   * 缺省 false = 池内分配(科目既有总预算落地到年份,各层总额不变)。
   */
  expandTotals?: boolean;
  // 调整原因按维度分开(对应总预算/年度预算两份导出文档)。
  totalReason?: string | null;
  annualReason?: string | null;
  lines: AdjustmentLineInput[];
}

/** 调整单 + 明细 + 锁的展开类型(getAdjustment / listAdjustments 返回)。 */
export type AdjustmentWithRelations = Prisma.BudgetAdjustmentGetPayload<{
  include: { lines: true; locks: true };
}>;

/** 把 BudgetAdjustment 行序列化为快照对象(用于审计)。 */
function snapshotAdjustment(row: BudgetAdjustment): Record<string, unknown> {
  return snapshotRow({
    id: row.id,
    projectId: row.projectId,
    year: row.year,
    kind: row.kind,
    expandTotals: row.expandTotals,
    status: row.status,
    totalReason: row.totalReason,
    annualReason: row.annualReason,
    applicantId: row.applicantId,
    approverId: row.approverId,
  });
}

/** 归一化 payload.kind:'ADJUST' | 'ALLOCATE',非法值 422,缺省 ADJUST。 */
function normalizeKind(kind?: string | null): 'ADJUST' | 'ALLOCATE' {
  if (kind === undefined || kind === null || kind === '') return 'ADJUST';
  if (kind === AdjustmentKind.ADJUST || kind === AdjustmentKind.ALLOCATE) return kind;
  throw new HTTPError(422, `调整类型无效:${kind}(应为 ADJUST 或 ALLOCATE)`);
}

/** 校验年度为正整数(1900~9999)。 */
function assertValidYear(year: number, label = 'year'): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new HTTPError(422, `${label} 必须是 1900~9999 的正整数`);
  }
}

/** 解析金额字符串为 Decimal(允许负数、允许 0)。 */
function parseSignedAmount(amount: string, label: string): D {
  let d: D;
  try {
    d = new D(amount);
  } catch {
    throw new HTTPError(422, `${label} 金额格式无效:${amount}`);
  }
  if (!d.isFinite()) {
    throw new HTTPError(422, `${label} 金额格式无效:${amount}`);
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

/** 校验新增科目:父节点存在且为非叶;名称项目内不重名。 */
async function validateNewSubject(
  tx: Prisma.TransactionClient | typeof prisma,
  projectId: string,
  name: string,
  parentId: string,
): Promise<void> {
  const parent = await tx.budgetSubject.findUnique({ where: { id: parentId } });
  if (!parent || parent.projectId !== projectId) {
    throw new HTTPError(422, `新增科目的父节点 ${parentId} 不属于该项目`);
  }
  if (parent.isLeaf) {
    throw new HTTPError(422, `新增科目必须挂在非叶节点下,${parent.name} 是叶节点`);
  }
  const dup = await tx.budgetSubject.findFirst({
    where: { projectId, name },
    select: { id: true },
  });
  if (dup) {
    throw new HTTPError(422, `新增科目名称"${name}"在项目内已存在`);
  }
}

/** 单行校验 + 解析金额。
 *  现有科目:subjectId 有值。新增科目:subjectId 空,newSubjectName/newSubjectParentId 有值。
 *  科目存在性/叶校验由调用方在事务内完成。 */
interface ParsedLine {
  subjectId: string | null;
  newSubjectName: string | null;
  newSubjectParentId: string | null;
  total: D;
  annual: D;
}

function validateAndParseLines(payload: AdjustmentPayload): ParsedLine[] {
  if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new HTTPError(422, '调整明细不能为空');
  }
  return payload.lines.map((line, i) => {
    const subjectId = line.subjectId?.trim() || null;
    const newName = line.newSubjectName?.trim() || null;
    const newParentId = line.newSubjectParentId?.trim() || null;
    // 二选一:要么引用现有科目,要么新增科目(name+parentId 齐备)。
    const isExisting = !!subjectId;
    const isNew = !!newName && !!newParentId;
    if (!isExisting && !isNew) {
      throw new HTTPError(422, `第 ${i + 1} 行需选择现有科目,或填写新增科目名称与父节点`);
    }
    if (isExisting && isNew) {
      throw new HTTPError(422, `第 ${i + 1} 行不能同时指定现有科目和新增科目`);
    }
    return {
      subjectId,
      newSubjectName: newName,
      newSubjectParentId: newParentId,
      total: parseSignedAmount(line.totalAdjustment, `第 ${i + 1} 行总预算调整额`),
      annual: parseSignedAmount(line.annualAdjustment, `第 ${i + 1} 行年度调整额`),
    };
  });
}

/**
 * §7 双维度收支平衡校验(仅 ADJUST):Σ total === 0 且 Σ annual === 0。
 * 不平衡 → 422。
 */
function assertBalanced(parsedLines: ParsedLine[]): void {
  const totalSum = sumAmounts(parsedLines.map((l) => l.total));
  const annualSum = sumAmounts(parsedLines.map((l) => l.annual));
  if (!totalSum.eq(ZERO)) {
    throw new HTTPError(422, `总预算维度调整不平衡:合计 ${totalSum.toFixed(2)} ≠ 0(须收支平衡)`);
  }
  if (!annualSum.eq(ZERO)) {
    throw new HTTPError(422, `年度预算维度调整不平衡:合计 ${annualSum.toFixed(2)} ≠ 0(须收支平衡)`);
  }
}

/**
 * §7 追加下达(ALLOCATE)结构校验:每行 total 必须 0、annual ≥ 0,且 Σ annual > 0。
 * 返回本单合计下达额 X。
 */
function validateAllocate(parsedLines: ParsedLine[]): D {
  for (const [i, line] of parsedLines.entries()) {
    if (!line.total.eq(ZERO)) {
      throw new HTTPError(
        422,
        `追加下达第 ${i + 1} 行的总预算调整额须为 0(总预算不变,只做年度分配)`,
      );
    }
    if (line.annual.isNeg()) {
      throw new HTTPError(422, `追加下达第 ${i + 1} 行的年度下达额不能为负(调减请改用调剂单)`);
    }
    if (!line.subjectId && line.annual.eq(ZERO)) {
      throw new HTTPError(
        422,
        `追加下达第 ${i + 1} 行的新增科目"${line.newSubjectName}"分配额须大于 0(不接受零额建档)`,
      );
    }
  }
  const annualSum = sumAmounts(parsedLines.map((l) => l.annual));
  if (annualSum.lte(ZERO)) {
    throw new HTTPError(422, '追加下达至少需要一行正数年度下达额');
  }
  return annualSum;
}

/**
 * §7 追加下达容量护栏(现有科目行):
 * 分配额 ≤ 科目总预算(currentAmount) − 该科目历年已分配 SubjectBudget.currentAmount 合计。
 */
async function assertAllocateCapacity(
  tx: Prisma.TransactionClient,
  projectId: string,
  parsedLines: ParsedLine[],
): Promise<void> {
  // 按科目合并(同一科目多行相加),跳过新增科目行(无历史总额,首笔立账)。
  const allocatedBySubject = new Map<string, D>();
  for (const line of parsedLines) {
    if (!line.subjectId || line.annual.eq(ZERO)) continue;
    const sid = line.subjectId;
    allocatedBySubject.set(sid, (allocatedBySubject.get(sid) ?? ZERO).plus(line.annual));
  }

  for (const [subjectId, amount] of allocatedBySubject.entries()) {
    const stb = await tx.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId, subjectId } },
      select: { currentAmount: true },
    });
    if (!stb) {
      throw new HTTPError(422, `科目 ${subjectId} 无总预算记录,请以新增科目行方式下达`);
    }
    const yearlySums = await tx.subjectBudget.aggregate({
      where: { projectId, subjectId },
      _sum: { currentAmount: true },
    });
    const totalCurrent = fromStored(stb.currentAmount);
    const alreadyAllocated = fromStored(yearlySums._sum.currentAmount ?? '0');
    const remaining = totalCurrent.minus(alreadyAllocated);
    if (amount.gt(remaining)) {
      throw new HTTPError(
        422,
        `超出剩余可分配额度:该科目剩余 ${remaining.toFixed(2)}(总预算 ${totalCurrent.toFixed(2)} − 历年已分配 ${alreadyAllocated.toFixed(2)}),本次申请 ${amount.toFixed(2)}`,
      );
    }
  }
}

/**
 * §7 创建调整草稿。
 * - 校验:行结构、平衡、项目存在且未归档、subjectId 为项目叶节点。
 * - 状态 DRAFT,不写锁。
 */
export async function createAdjustment(
  projectId: string,
  payload: AdjustmentPayload,
  user: Pick<User, 'id' | 'role'>,
): Promise<BudgetAdjustment> {
  await requirePermission(user, 'budget:adjust', projectId);

  if (payload?.year === undefined || payload?.year === null) {
    throw new HTTPError(422, '缺少 year(调整年度)');
  }
  assertValidYear(payload.year, 'year');

  // 草稿允许不平衡(中间态),平衡校验推迟到提交(submitAdjustment)。
  const parsedLines = validateAndParseLines(payload);

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

  for (const line of parsedLines) {
    if (line.subjectId) {
      await requireLeafSubject(prisma, projectId, line.subjectId);
    } else {
      // 新增科目:校验父节点(非叶)+ 名称项目内不重名。
      await validateNewSubject(prisma, projectId, line.newSubjectName!, line.newSubjectParentId!);
    }
  }

  const id = uuidv7();
  const totalReason = payload.totalReason?.trim() ? payload.totalReason.trim() : null;
  const annualReason = payload.annualReason?.trim() ? payload.annualReason.trim() : null;
  const year = payload.year;
  const kind = normalizeKind(payload.kind);
  // expandTotals 仅 ALLOCATE 有意义;ADJUST 一律落 false。
  const expandTotals = kind === 'ALLOCATE' && payload.expandTotals === true;

  return prisma.$transaction(async (tx) => {
    const created = await tx.budgetAdjustment.create({
      data: {
        id,
        projectId,
        year,
        kind,
        expandTotals,
        status: ApprovalStatus.DRAFT,
        totalReason,
        annualReason,
        applicantId: user.id,
      },
    });

    for (const line of parsedLines) {
      await tx.budgetAdjustmentLine.create({
        data: {
          id: uuidv7(),
          adjustmentId: id,
          year,
          subjectId: line.subjectId,
          totalAdjustment: toStored(line.total),
          annualAdjustment: toStored(line.annual),
          newSubjectName: line.newSubjectName,
          newSubjectParentId: line.newSubjectParentId,
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

/**
 * §7 编辑调整草稿(仅 DRAFT 可改):重建明细行 + 更新年度/原因。
 * 校验逻辑与 createAdjustment 一致;不涉及锁(DRAFT 无锁)。
 */
export async function updateDraftAdjustment(
  adjId: string,
  payload: AdjustmentPayload,
  user: Pick<User, 'id' | 'role'>,
): Promise<BudgetAdjustment> {
  // 项目级权限需要先知道调整单所属项目(轻量预查;事务内会再取全量做状态校验)。
  const adjRef = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    select: { projectId: true },
  });
  if (!adjRef) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:adjust', adjRef.projectId);

  if (payload?.year === undefined || payload?.year === null) {
    throw new HTTPError(422, '缺少 year(调整年度)');
  }
  assertValidYear(payload.year, 'year');

  // 草稿允许不平衡,平衡校验推迟到提交。
  const parsedLines = validateAndParseLines(payload);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.budgetAdjustment.findUnique({ where: { id: adjId } });
    if (!existing) {
      throw new HTTPError(404, '调整单不存在');
    }
    if (existing.status !== ApprovalStatus.DRAFT) {
      throw new HTTPError(409, `仅草稿可编辑,当前状态:${existing.status}`);
    }
    const projectId = existing.projectId;

    for (const line of parsedLines) {
      if (line.subjectId) {
        await requireLeafSubject(tx, projectId, line.subjectId);
      } else {
        await validateNewSubject(tx, projectId, line.newSubjectName!, line.newSubjectParentId!);
      }
    }

    const totalReason = payload.totalReason?.trim() ? payload.totalReason.trim() : null;
    const annualReason = payload.annualReason?.trim() ? payload.annualReason.trim() : null;
    const updated = await tx.budgetAdjustment.update({
      where: { id: adjId },
      data: {
        year: payload.year,
        kind: normalizeKind(payload.kind),
        expandTotals: normalizeKind(payload.kind) === 'ALLOCATE' && payload.expandTotals === true,
        totalReason,
        annualReason,
      },
    });

    // 重建明细行(先删后建)。
    await tx.budgetAdjustmentLine.deleteMany({ where: { adjustmentId: adjId } });
    for (const line of parsedLines) {
      await tx.budgetAdjustmentLine.create({
        data: {
          id: uuidv7(),
          adjustmentId: adjId,
          year: payload.year,
          subjectId: line.subjectId,
          totalAdjustment: toStored(line.total),
          annualAdjustment: toStored(line.annual),
          newSubjectName: line.newSubjectName,
          newSubjectParentId: line.newSubjectParentId,
        },
      });
    }

    await recordAudit(tx, {
      projectId,
      objectType: 'budget_adjustments',
      objectId: adjId,
      action: 'update',
      operatorId: user.id,
      before: snapshotAdjustment(existing),
      after: snapshotAdjustment(updated),
    });

    return updated;
  });
}

/**
 * §7 删除调整草稿(仅 DRAFT 可删;明细行级联清理)。
 */
export async function deleteDraftAdjustment(
  adjId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
  // 同 updateDraftAdjustment:先轻量预查 projectId 再做项目级权限校验。
  const adjRef = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    select: { projectId: true },
  });
  if (!adjRef) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:adjust', adjRef.projectId);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.budgetAdjustment.findUnique({ where: { id: adjId } });
    if (!existing) {
      throw new HTTPError(404, '调整单不存在');
    }
    if (existing.status !== ApprovalStatus.DRAFT) {
      throw new HTTPError(409, `仅草稿可删除,当前状态:${existing.status}`);
    }

    await tx.budgetAdjustmentLine.deleteMany({ where: { adjustmentId: adjId } });
    await tx.budgetAdjustment.delete({ where: { id: adjId } });

    await recordAudit(tx, {
      projectId: existing.projectId,
      objectType: 'budget_adjustments',
      objectId: adjId,
      action: 'delete',
      operatorId: user.id,
      before: snapshotAdjustment(existing),
    });
  });
}

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

/** §7 取单个调整单(含明细 + 锁)。 */
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

/** 查询某 (year, subjectId) 上已存在且未释放的待审批锁合计。 */
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
 * §7 提交审批(DRAFT → PENDING)。
 * - 复跑平衡校验。
 * - 对年度维度调减(annualAdjustment < 0)的每个 (year, subjectId):
 *   校验 |调减| ≤ 可调额度(current - 占用),并叠加已有待审批锁;为每个调减行写一条锁。
 * - 写完锁置 PENDING。
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

  const parsedLines = adj.lines.map((l) => ({
    subjectId: l.subjectId,
    newSubjectName: l.newSubjectName,
    newSubjectParentId: l.newSubjectParentId,
    total: fromStored(l.totalAdjustment),
    annual: fromStored(l.annualAdjustment),
  }));

  if (adj.kind === AdjustmentKind.ALLOCATE) {
    // 追加下达:正向 + 非零合计;池内分配再做容量护栏(expandTotals 不设上限);无锁、无零和校验。
    validateAllocate(parsedLines);
    return prisma.$transaction(async (tx) => {
      await lockAndRecheckStatus(tx, adjId, ApprovalStatus.DRAFT);
      if (!adj.expandTotals) {
        await assertAllocateCapacity(tx, adj.projectId, parsedLines);
      }
      const submitted = await tx.budgetAdjustment.update({
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
        after: snapshotAdjustment(submitted),
      });
      return submitted;
    });
  }

  assertBalanced(parsedLines);
  // 新增科目行原预算为 0,调减无意义(应只调增)。
  for (const line of parsedLines) {
    if (!line.subjectId && (line.total.isNeg() || line.annual.isNeg())) {
      throw new HTTPError(422, `新增科目"${line.newSubjectName}"原预算为 0,不可调减`);
    }
  }

  return prisma.$transaction(async (tx) => {
    await lockAndRecheckStatus(tx, adjId, ApprovalStatus.DRAFT);
    // 按科目合并年度调减合计(同一科目多行可能分别调减)。
    const decreaseBySubject = new Map<string, { year: number; subjectId: string; amount: D }>();
    for (const line of parsedLines) {
      if (!line.annual.isNeg()) continue; // 仅年度维度调减(新增科目已被上方拦截不可调减)
      // 能到这里的都是现有科目行(subjectId 非空)。
      const sid = line.subjectId!;
      const key = `${adj.year}:${sid}`;
      const prev = decreaseBySubject.get(key);
      const decAmount = line.annual.abs();
      decreaseBySubject.set(key, {
        year: adj.year,
        subjectId: sid,
        amount: prev ? prev.amount.plus(decAmount) : decAmount,
      });
    }

    // 校验可调额度 + 写锁。
    for (const [, info] of decreaseBySubject.entries()) {
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
      const occ = computeOccupancy({ records });
      const adjustable = adjustableAmount(currentBudget, occ.totalOccupied);
      if (info.amount.gt(adjustable)) {
        throw new HTTPError(
          422,
          `调出额度不足:科目可调额度 ${adjustable.toFixed(2)},本次年度调减 ${info.amount.toFixed(2)}`,
        );
      }
      const prevLock = await existingPendingLock(tx, adj.projectId, info.year, info.subjectId);
      if (prevLock.plus(info.amount).gt(adjustable)) {
        throw new HTTPError(
          422,
          `调出额度不足:已有待审批锁 ${prevLock.toFixed(2)},本次再调减 ${info.amount.toFixed(2)} 将超额`,
        );
      }
      // 写锁。
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

    const submitted = await tx.budgetAdjustment.update({
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
      after: snapshotAdjustment(submitted),
    });

    return submitted;
  });
}

/** 释放本单全部未释放锁。 */
async function releaseLocks(tx: Prisma.TransactionClient, adjId: string, now: Date): Promise<void> {
  await tx.budgetLock.updateMany({
    where: { adjustmentId: adjId, releasedAt: null },
    data: { releasedAt: now },
  });
}

/**
 * 锁定调整单行并复核状态(双重提交/双重审批竞态防护):
 * 事务内 FOR UPDATE 行锁串行化并发请求,锁内重读状态——第二个请求会看到
 * 第一个已提交的状态变化并 409,而不是基于事务前读取的旧状态重复应用金额。
 */
async function lockAndRecheckStatus(
  tx: Prisma.TransactionClient,
  adjId: string,
  expected: ApprovalStatus,
): Promise<void> {
  await tx.$queryRaw`SELECT status FROM budget_adjustments WHERE id = ${adjId}::uuid FOR UPDATE`;
  const fresh = await tx.budgetAdjustment.findUniqueOrThrow({
    where: { id: adjId },
    select: { status: true },
  });
  if (fresh.status !== expected) {
    throw new HTTPError(409, `当前状态 ${fresh.status} 与预期 ${expected} 不符(已被并发操作处理)`);
  }
}

/**
 * §7 审批通过(PENDING → APPROVED)。
 * - 复跑平衡校验。
 * - 重新校验每个年度调减叶节点的可调额度(§7.5:提交后可能新增业务占用导致不足)。
 * - 应用双维度 delta:
 *   · 年度维度:SubjectBudget.currentAmount += annualAdjustment(adjustmentAmount 同步累加)。
 *   · 总预算维度:SubjectTotalBudget.currentAmount += totalAdjustment(adjustmentAmount 同步累加)。
 * - 安全断言:生效后每个受影响叶节点的年度 current ≥ 占用。
 * - 释放锁,置 APPROVED。
 */
export async function approveAdjustment(
  adjId: string,
  user: Pick<User, 'id' | 'role'>,
  opinion?: string,
): Promise<BudgetAdjustment> {
  const adj = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    include: { lines: true },
  });
  if (!adj) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:approve', adj.projectId);

  if (adj.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${adj.status} 不可审批,仅 PENDING 可审批`);
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // 双重审批防护:行锁 + 锁内复核状态(两个并发审批只有一个能通过);
    // 即使复核被绕过,末尾的条件化状态迁移 + 事务回滚仍保证金额不重复应用。
    await lockAndRecheckStatus(tx, adjId, ApprovalStatus.PENDING);
    const parsedLines = adj.lines.map((l) => ({
      subjectId: l.subjectId as string | null,
      newSubjectName: l.newSubjectName,
      newSubjectParentId: l.newSubjectParentId,
      total: fromStored(l.totalAdjustment),
      annual: fromStored(l.annualAdjustment),
    }));

    // ===== 追加下达(ALLOCATE)生效路径 =====
    if (adj.kind === AdjustmentKind.ALLOCATE) {
      // 并发串行化(P1):锁项目总预算行,同项目的追加审批在此排队——
      // 后续容量校验读到的是前一笔已提交的总额,ProjectBudget 读改写也不再丢更新。
      await tx.$queryRaw`SELECT project_id FROM project_budgets WHERE project_id = ${adj.projectId}::uuid FOR UPDATE`;

      const yearTotal = validateAllocate(parsedLines);
      // expandTotals=false(池内分配)才做容量护栏;开启时科目总预算随行调增,无上限。
      if (!adj.expandTotals) {
        await assertAllocateCapacity(tx, adj.projectId, parsedLines);
      }

      // 1) 新增科目行:建档(叶)+ 该年 SubjectBudget + SubjectTotalBudget(首笔分配额立账)。
      //    建账即含本次分配额,已计入 createdNewSubjects,第 3 步跳过防双计。
      const createdNewSubjects = new Set<string>();
      const maxSortOrder = await tx.budgetSubject.aggregate({
        where: { projectId: adj.projectId },
        _max: { sortOrder: true },
      });
      let nextSort = (maxSortOrder._max.sortOrder ?? -1) + 1;
      for (const line of parsedLines) {
        if (line.subjectId) continue;
        await validateNewSubject(tx, adj.projectId, line.newSubjectName!, line.newSubjectParentId!);
        const parent = await tx.budgetSubject.findUnique({
          where: { id: line.newSubjectParentId! },
          select: { level: true },
        });
        const newSubjectId = uuidv7();
        await tx.budgetSubject.create({
          data: {
            id: newSubjectId,
            projectId: adj.projectId,
            parentId: line.newSubjectParentId,
            code: uuidv7(),
            name: line.newSubjectName!,
            level: (parent?.level ?? 1) + 1,
            isLeaf: true,
            sortOrder: nextSort++,
          },
        });
        // 该年 SubjectBudget:全部计入 adjustmentAmount(initial 保持 0,与调剂口径一致)。
        await tx.subjectBudget.create({
          data: {
            id: uuidv7(),
            projectId: adj.projectId,
            year: adj.year,
            subjectId: newSubjectId,
            initialAmount: toStored(ZERO),
            adjustmentAmount: toStored(line.annual),
            currentAmount: toStored(line.annual),
          },
        });
        // 总预算以首笔分配额立账(科目此前不存在,无"编制期总额")。
        await tx.subjectTotalBudget.create({
          data: {
            id: uuidv7(),
            projectId: adj.projectId,
            subjectId: newSubjectId,
            initialAmount: toStored(ZERO),
            adjustmentAmount: toStored(line.annual),
            currentAmount: toStored(line.annual),
          },
        });
        line.subjectId = newSubjectId;
        createdNewSubjects.add(newSubjectId);
      }

      // 2) 年度维度:现有科目 SubjectBudget 缺行则创建(initial=0),有行则累加。
      //    (isNew 行已在第 1 步建账含额,跳过。)
      for (const line of parsedLines) {
        if (!line.subjectId || createdNewSubjects.has(line.subjectId)) continue;
        if (line.annual.eq(ZERO)) continue;
        const sb = await tx.subjectBudget.findUnique({
          where: {
            projectId_year_subjectId: {
              projectId: adj.projectId,
              year: adj.year,
              subjectId: line.subjectId,
            },
          },
        });
        if (!sb) {
          await tx.subjectBudget.create({
            data: {
              id: uuidv7(),
              projectId: adj.projectId,
              year: adj.year,
              subjectId: line.subjectId!,
              initialAmount: toStored(ZERO),
              adjustmentAmount: toStored(line.annual),
              currentAmount: toStored(line.annual),
            },
          });
        } else {
          await tx.subjectBudget.update({
            where: { id: sb.id },
            data: {
              currentAmount: toStored(fromStored(sb.currentAmount).plus(line.annual)),
              adjustmentAmount: toStored(fromStored(sb.adjustmentAmount).plus(line.annual)),
            },
          });
        }
      }

      // 2.5) expandTotals(新经费入账):现有科目的总预算随下达额同步调增。
      //      (isNew 行第 1 步已按首笔分配额立账;池内模式则不动 STB。)
      if (adj.expandTotals) {
        for (const line of parsedLines) {
          if (!line.subjectId || createdNewSubjects.has(line.subjectId)) continue;
          if (line.annual.eq(ZERO)) continue;
          const stb = await tx.subjectTotalBudget.findUnique({
            where: {
              projectId_subjectId: { projectId: adj.projectId, subjectId: line.subjectId! },
            },
          });
          if (!stb) {
            await tx.subjectTotalBudget.create({
              data: {
                id: uuidv7(),
                projectId: adj.projectId,
                subjectId: line.subjectId!,
                initialAmount: toStored(ZERO),
                adjustmentAmount: toStored(line.annual),
                currentAmount: toStored(line.annual),
              },
            });
          } else {
            await tx.subjectTotalBudget.update({
              where: { id: stb.id },
              data: {
                currentAmount: toStored(fromStored(stb.currentAmount).plus(line.annual)),
                adjustmentAmount: toStored(fromStored(stb.adjustmentAmount).plus(line.annual)),
              },
            });
          }
        }
      }

      // 3) 年度盘子:AnnualBudget 新建或累加 += X。
      //    initial 不动(保持"编制下达额"语义),追加全部计入 adjustment,
      //    维持 current = initial + adjustment 恒等式。
      const annualBudget = await tx.annualBudget.findUnique({
        where: { projectId_year: { projectId: adj.projectId, year: adj.year } },
      });
      if (!annualBudget) {
        await tx.annualBudget.create({
          data: {
            id: uuidv7(),
            projectId: adj.projectId,
            year: adj.year,
            initialAmount: toStored(yearTotal),
            adjustmentAmount: toStored(ZERO),
            currentAmount: toStored(yearTotal),
          },
        });
      } else {
        await tx.annualBudget.update({
          where: { id: annualBudget.id },
          data: {
            adjustmentAmount: toStored(fromStored(annualBudget.adjustmentAmount).plus(yearTotal)),
            currentAmount: toStored(fromStored(annualBudget.currentAmount).plus(yearTotal)),
          },
        });
      }

      // 4) 项目总盘:仅 expandTotals(新经费入账)时 += X(人才类项目总额能涨);
      //    池内分配不动总盘——钱本就在项目预算内,只是落地到年份。
      if (adj.expandTotals) {
        const projectBudget = await tx.projectBudget.findUnique({
          where: { projectId: adj.projectId },
        });
        if (!projectBudget) {
          throw new HTTPError(422, '项目总预算不存在(须先完成初始预算编制并审批)');
        }
        await tx.projectBudget.update({
          where: { projectId: adj.projectId },
          data: {
            adjustmentAmount: toStored(fromStored(projectBudget.adjustmentAmount).plus(yearTotal)),
            currentAmount: toStored(fromStored(projectBudget.currentAmount).plus(yearTotal)),
          },
        });
      }

      // 追加只做正向下达,无锁可释放。条件化状态迁移(仅 PENDING → APPROVED 恰好一行)。
      const upd = await tx.budgetAdjustment.updateMany({
        where: { id: adjId, status: ApprovalStatus.PENDING },
        data: { status: ApprovalStatus.APPROVED, approverId: user.id, approvedAt: now },
      });
      if (upd.count !== 1) {
        throw new HTTPError(409, '调整单状态已变化,审批未生效');
      }
      const approvedAlloc = await tx.budgetAdjustment.findUniqueOrThrow({ where: { id: adjId } });
      await recordAudit(tx, {
        projectId: adj.projectId,
        objectType: 'budget_adjustments',
        objectId: adjId,
        action: 'approve',
        operatorId: user.id,
        before: snapshotAdjustment(adj),
        after: { ...snapshotAdjustment(approvedAlloc), opinion: opinion ?? null },
      });
      return approvedAlloc;
    }

    // ===== 调剂(ADJUST)生效路径(现状逻辑) =====
    assertBalanced(parsedLines);

    // 先落库新增科目(subjectId 为空的行):建 BudgetSubject(叶)+ 该年度
    // SubjectBudget(0) + SubjectTotalBudget(0),回填 subjectId 到 parsedLines。
    // 必须在应用 delta 之前完成,否则 SubjectBudget 缺失会 422。
    const maxSortOrder = await tx.budgetSubject.aggregate({
      where: { projectId: adj.projectId },
      _max: { sortOrder: true },
    });
    let nextSort = (maxSortOrder._max.sortOrder ?? -1) + 1;
    for (const line of parsedLines) {
      if (line.subjectId) continue;
      // 校验父节点(非叶)+ 重名(草稿后可能已被改)。
      await validateNewSubject(tx, adj.projectId, line.newSubjectName!, line.newSubjectParentId!);
      const parent = await tx.budgetSubject.findUnique({
        where: { id: line.newSubjectParentId! },
        select: { level: true },
      });
      const newSubjectId = uuidv7();
      await tx.budgetSubject.create({
        data: {
          id: newSubjectId,
          projectId: adj.projectId,
          parentId: line.newSubjectParentId,
          code: uuidv7(), // 项目内唯一(用 uuid 兜底)
          name: line.newSubjectName!,
          level: (parent?.level ?? 1) + 1,
          isLeaf: true,
          sortOrder: nextSort++,
        },
      });
      // 初始化该年度 SubjectBudget(initial=0,current=0)。
      await tx.subjectBudget.create({
        data: {
          id: uuidv7(),
          projectId: adj.projectId,
          year: adj.year,
          subjectId: newSubjectId,
          initialAmount: toStored(ZERO),
          adjustmentAmount: toStored(ZERO),
          currentAmount: toStored(ZERO),
        },
      });
      // 初始化 SubjectTotalBudget(initial=0,current=0)。
      await tx.subjectTotalBudget.create({
        data: {
          id: uuidv7(),
          projectId: adj.projectId,
          subjectId: newSubjectId,
          initialAmount: toStored(ZERO),
          adjustmentAmount: toStored(ZERO),
          currentAmount: toStored(ZERO),
        },
      });
      line.subjectId = newSubjectId;
    }

    // 按科目合并年度调减合计,逐个重新校验可调额度(§7.5)。
    const decreaseBySubject = new Map<string, { year: number; subjectId: string; amount: D }>();
    for (const line of parsedLines) {
      if (!line.annual.isNeg()) continue;
      const sid = line.subjectId!; // 新增科目已在上方落库回填,必非空。
      const key = `${adj.year}:${sid}`;
      const prev = decreaseBySubject.get(key);
      decreaseBySubject.set(key, {
        year: adj.year,
        subjectId: sid,
        amount: prev ? prev.amount.plus(line.annual.abs()) : line.annual.abs(),
      });
    }
    for (const [, info] of decreaseBySubject.entries()) {
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
      const occ = computeOccupancy({ records });
      const adjustable = adjustableAmount(currentBudget, occ.totalOccupied);
      if (info.amount.gt(adjustable)) {
        throw new HTTPError(
          422,
          `审批时额度不足:科目可调额度 ${adjustable.toFixed(2)},年度调减 ${info.amount.toFixed(2)}(§7.5)`,
        );
      }
    }

    // 应用年度维度 delta:SubjectBudget.currentAmount/adjustmentAmount。
    const annualDeltaBySubject = new Map<string, D>();
    for (const line of parsedLines) {
      // 新增科目已在上方落库并回填 subjectId,此处必非空。
      const sid = line.subjectId!;
      annualDeltaBySubject.set(sid, (annualDeltaBySubject.get(sid) ?? ZERO).plus(line.annual));
    }
    for (const [subjectId, delta] of annualDeltaBySubject.entries()) {
      if (delta.eq(ZERO)) continue;
      const sb = await tx.subjectBudget.findUnique({
        where: {
          projectId_year_subjectId: { projectId: adj.projectId, year: adj.year, subjectId },
        },
      });
      if (!sb) {
        throw new HTTPError(422, `科目年度预算不存在(年度 ${adj.year})`);
      }
      const next = fromStored(sb.currentAmount).plus(delta);
      const nextAdj = fromStored(sb.adjustmentAmount).plus(delta);
      await tx.subjectBudget.update({
        where: { id: sb.id },
        data: { currentAmount: toStored(next), adjustmentAmount: toStored(nextAdj) },
      });
    }

    // 应用总预算维度 delta:SubjectTotalBudget.currentAmount/adjustmentAmount。
    const totalDeltaBySubject = new Map<string, D>();
    for (const line of parsedLines) {
      const sid = line.subjectId!;
      totalDeltaBySubject.set(sid, (totalDeltaBySubject.get(sid) ?? ZERO).plus(line.total));
    }
    for (const [subjectId, delta] of totalDeltaBySubject.entries()) {
      if (delta.eq(ZERO)) continue;
      const stb = await tx.subjectTotalBudget.findUnique({
        where: { projectId_subjectId: { projectId: adj.projectId, subjectId } },
      });
      if (!stb) {
        // 编制时未填总预算的科目:调整以 0 为基准 upsert 创建。
        await tx.subjectTotalBudget.create({
          data: {
            id: uuidv7(),
            projectId: adj.projectId,
            subjectId,
            initialAmount: toStored(ZERO),
            adjustmentAmount: toStored(delta),
            currentAmount: toStored(delta),
          },
        });
      } else {
        const next = fromStored(stb.currentAmount).plus(delta);
        const nextAdj = fromStored(stb.adjustmentAmount).plus(delta);
        await tx.subjectTotalBudget.update({
          where: { id: stb.id },
          data: { currentAmount: toStored(next), adjustmentAmount: toStored(nextAdj) },
        });
      }
    }

    // 安全再断言(§7.4):生效后每个年度维度受影响叶节点 current ≥ 占用。
    for (const subjectId of annualDeltaBySubject.keys()) {
      const [sb, records] = await Promise.all([
        tx.subjectBudget.findUnique({
          where: {
            projectId_year_subjectId: { projectId: adj.projectId, year: adj.year, subjectId },
          },
        }),
        tx.businessRecord.findMany({
          where: {
            projectId: adj.projectId,
            budgetYear: adj.year,
            subjectId,
            isVoid: false,
          },
          select: { amount: true, status: true, isVoid: true },
        }),
      ]);
      const current = sb ? fromStored(sb.currentAmount) : ZERO;
      const occ = computeOccupancy({ records });
      if (current.lt(occ.totalOccupied)) {
        throw new HTTPError(
          422,
          `生效后科目当前预算 ${current.toFixed(2)} 低于总占用 ${occ.totalOccupied.toFixed(2)}(§7.4)`,
        );
      }
    }

    // 释放锁。
    await releaseLocks(tx, adjId, now);

    // 置 APPROVED + 审计。条件化状态迁移(仅 PENDING → APPROVED 恰好一行)。
    const upd = await tx.budgetAdjustment.updateMany({
      where: { id: adjId, status: ApprovalStatus.PENDING },
      data: {
        status: ApprovalStatus.APPROVED,
        approverId: user.id,
        approvedAt: now,
      },
    });
    if (upd.count !== 1) {
      throw new HTTPError(409, '调整单状态已变化,审批未生效');
    }
    const approved = await tx.budgetAdjustment.findUniqueOrThrow({ where: { id: adjId } });

    await recordAudit(tx, {
      projectId: adj.projectId,
      objectType: 'budget_adjustments',
      objectId: adjId,
      action: 'approve',
      operatorId: user.id,
      before: snapshotAdjustment(adj),
      after: { ...snapshotAdjustment(approved), opinion: opinion ?? null },
    });

    return approved;
  });
}

/** §7 驳回(PENDING → REJECTED):释放锁,不改 current。opinion 必填。 */
export async function rejectAdjustment(
  adjId: string,
  user: Pick<User, 'id' | 'role'>,
  opinion: string,
): Promise<BudgetAdjustment> {
  const adj = await prisma.budgetAdjustment.findUnique({ where: { id: adjId } });
  if (!adj) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:approve', adj.projectId);

  if (adj.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${adj.status} 不可驳回,仅 PENDING 可驳回`);
  }
  if (!opinion || !opinion.trim()) {
    throw new HTTPError(422, '驳回需填写意见');
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await releaseLocks(tx, adjId, now);
    const rejected = await tx.budgetAdjustment.update({
      where: { id: adjId },
      data: { status: ApprovalStatus.REJECTED },
    });
    await recordAudit(tx, {
      projectId: adj.projectId,
      objectType: 'budget_adjustments',
      objectId: adjId,
      action: 'reject',
      operatorId: user.id,
      before: snapshotAdjustment(adj),
      after: { ...snapshotAdjustment(rejected), opinion: opinion.trim() },
    });
    return rejected;
  });
}

/** §7 撤回(PENDING → DRAFT):释放锁,允许申请人继续编辑。 */
export async function withdrawAdjustment(
  adjId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<BudgetAdjustment> {
  const adj = await prisma.budgetAdjustment.findUnique({ where: { id: adjId } });
  if (!adj) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:adjust', adj.projectId);

  if (adj.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${adj.status} 不可撤回,仅 PENDING 可撤回`);
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await releaseLocks(tx, adjId, now);
    const withdrawn = await tx.budgetAdjustment.update({
      where: { id: adjId },
      data: { status: ApprovalStatus.DRAFT },
    });
    await recordAudit(tx, {
      projectId: adj.projectId,
      objectType: 'budget_adjustments',
      objectId: adjId,
      action: 'withdraw',
      operatorId: user.id,
      before: snapshotAdjustment(adj),
      after: snapshotAdjustment(withdrawn),
    });
    return withdrawn;
  });
}
