import { AdjustmentKind, ApprovalStatus, BudgetAdjustment, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, sumAmounts, toStored } from '@/lib/decimal';
import { adjustableAmount, computeOccupancy } from '@/lib/budget';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';
import { buildBaselineAmounts } from '@/server/services/adjustmentBaseline.service';

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
  // 新增科目(仅 subjectId 为空时):名称 + 父节点(可省略 = 一级科目;无预算的叶节点亦可挂子科目)。
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
  include: { lines: { orderBy: { id: 'asc' } }; locks: true };
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

/**
 * §包干制(LUMP_SUM)总维度拒绝:项目没有科目总预算层,任何一行
 * totalAdjustment ≠ 0 都 422(年度维度照常)。创建与编辑两处入口都拦。
 */
async function assertAnnualOnlyForLumpSum(
  db: Prisma.TransactionClient | typeof prisma,
  projectId: string,
  lines: { total: D }[],
): Promise<void> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { budgetMode: true },
  });
  if (project?.budgetMode !== 'LUMP_SUM') return;
  const idx = lines.findIndex((l) => !l.total.eq(ZERO));
  if (idx >= 0) {
    throw new HTTPError(
      422,
      `包干制项目不编制科目总预算,第 ${idx + 1} 行的总预算调整额须为 0(仅允许年度维度调整)`,
    );
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

/**
 * 校验新增科目:父节点存在;名称项目内不重名。
 * 父节点(codex 放宽):**无预算的叶节点亦可挂子科目**——挂上后该节点转为非叶,
 * 预算由子科目汇总;已有预算(年度科目预算或科目总预算)的叶节点仍拒绝,
 * 否则其原有预算会因转为非叶而从汇总中消失,须先走拆分流程。
 */
async function validateNewSubject(
  tx: Prisma.TransactionClient | typeof prisma,
  projectId: string,
  name: string,
  parentId: string | null,
): Promise<void> {
  let parent: { name: string; isLeaf: boolean } | null = null;
  if (parentId) {
    const found = await tx.budgetSubject.findUnique({ where: { id: parentId } });
    if (!found || found.projectId !== projectId) {
      throw new HTTPError(422, `新增科目的父节点 ${parentId} 不属于该项目`);
    }
    parent = { name: found.name, isLeaf: found.isLeaf };
  }
  if (parent?.isLeaf && parentId) {
    const [hasAnnual, hasTotal] = await Promise.all([
      tx.subjectBudget.count({ where: { subjectId: parentId } }),
      tx.subjectTotalBudget.count({ where: { subjectId: parentId } }),
    ]);
    if (hasAnnual > 0 || hasTotal > 0) {
      throw new HTTPError(
        422,
        `新增科目必须挂在无预算的节点下,${parent.name} 已有预算;如需拆分请先调整其预算结构`,
      );
    }
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
    // 二选一:要么引用现有科目,要么新增科目(名称必填;父节点可省略 = 一级科目)。
    const isExisting = !!subjectId;
    const isNew = !!newName;
    if (!isExisting && !isNew) {
      throw new HTTPError(422, `第 ${i + 1} 行需选择现有科目,或填写新增科目名称`);
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
 * §总维度调减护栏:现有科目的总预算调整后不得为负
 * (用户反馈:外部协作费总经费被调成 -200——年度维度有可调额度护栏,总维度此前缺失)。
 *
 * 投影 = live 科目总预算 + 其他 PENDING 单的同科目净调减(保守:仅计调减侧,
 * 不计未审批的调增)+ 本单该科目 delta;投影 < 0 → 422。
 * 提交与审批两处都调:提交时拦截明显超调,审批时兜底并发(两单在途后先批一张
 * 挤占额度,后批的在本事务内被拒并回滚)。
 */
async function assertTotalDecreaseFloor(
  tx: Prisma.TransactionClient,
  projectId: string,
  excludeAdjId: string | null,
  lines: { subjectId: string | null; total: D }[],
): Promise<void> {
  // §codex P2:审批按科目**净额**生效,护栏必须同口径——同一科目多行(如 -700/+200)
  // 先聚合净 delta,仅对净调减的科目校验;逐行按负数累计会误杀净额合法的单。
  const netBySubject = new Map<string, D>();
  for (const l of lines) {
    if (!l.subjectId) continue;
    netBySubject.set(l.subjectId, (netBySubject.get(l.subjectId) ?? ZERO).plus(l.total));
  }
  const decreases = new Map<string, D>();
  for (const [subjectId, net] of netBySubject.entries()) {
    if (net.isNeg()) decreases.set(subjectId, net);
  }
  if (decreases.size === 0) return;

  // 锁定所有 total 非零的涉事科目总预算行(§codex P2):并发提交/审批在此串行化——
  // 否则两张 DRAFT 同时提交时,护栏的普通读看不到对方刚置的 PENDING,双双漏过。
  // 只锁净调减科目会在方向相反的两单间形成 A→B / B→A 锁环(delta 应用阶段会更新
  // 对方科目),故按统一排序预锁全部受影响科目。
  const affectedSubjects = [...netBySubject.entries()]
    .filter(([, net]) => !net.isZero())
    .map(([subjectId]) => subjectId)
    .sort();
  for (const subjectId of affectedSubjects) {
    await tx.$queryRaw`SELECT subject_id FROM subject_total_budgets WHERE project_id = ${projectId}::uuid AND subject_id = ${subjectId}::uuid FOR UPDATE`;
  }

  // 其他 PENDING 单:同样按科目聚合全部 delta 取净额,仅净调减计入投影。
  const pendingOthers = await tx.budgetAdjustment.findMany({
    where: {
      projectId,
      status: ApprovalStatus.PENDING,
      ...(excludeAdjId ? { id: { not: excludeAdjId } } : {}),
    },
    select: { lines: { select: { subjectId: true, totalAdjustment: true } } },
  });
  const pendingNeg = new Map<string, D>();
  for (const a of pendingOthers) {
    const net = new Map<string, D>();
    for (const line of a.lines) {
      if (!line.subjectId) continue;
      net.set(
        line.subjectId,
        (net.get(line.subjectId) ?? ZERO).plus(fromStored(String(line.totalAdjustment))),
      );
    }
    for (const [subjectId, d] of net.entries()) {
      if (d.isNeg()) {
        pendingNeg.set(subjectId, (pendingNeg.get(subjectId) ?? ZERO).plus(d));
      }
    }
  }

  for (const [subjectId, delta] of decreases.entries()) {
    const stb = await tx.subjectTotalBudget.findUnique({
      where: { projectId_subjectId: { projectId, subjectId } },
    });
    const current = stb ? fromStored(stb.currentAmount) : ZERO;
    const projected = current.plus(pendingNeg.get(subjectId) ?? ZERO).plus(delta);
    if (projected.isNeg()) {
      const subject = await tx.budgetSubject.findUnique({
        where: { id: subjectId },
        select: { name: true },
      });
      const pendingPart = pendingNeg.get(subjectId) ?? ZERO;
      throw new HTTPError(
        422,
        `科目"${subject?.name ?? subjectId}"总预算调整后将为 ${projected.toFixed(2)} 元,不能为负` +
          `(现总预算 ${current.toFixed(2)},在途调减 ${pendingPart.abs().toFixed(2)},本单净调减 ${delta.abs().toFixed(2)})`,
      );
    }
  }
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
 * §包干制(LUMP_SUM):无科目总预算池,改为项目级池——
 * Σ(本单下达) ≤ ProjectBudget.currentAmount − Σ 全部年度 AnnualBudget.currentAmount(未分配余额),
 * 与编制期的「Σ年度预算 ≤ 项目总预算」同口径。
 */
async function assertAllocateCapacity(
  tx: Prisma.TransactionClient,
  projectId: string,
  parsedLines: ParsedLine[],
): Promise<void> {
  const lumpSum =
    (
      await tx.project.findUnique({
        where: { id: projectId },
        select: { budgetMode: true },
      })
    )?.budgetMode === 'LUMP_SUM';

  // 按科目合并(同一科目多行相加),跳过新增科目行(无历史总额,首笔立账)。
  const allocatedBySubject = new Map<string, D>();
  for (const line of parsedLines) {
    if (!line.subjectId || line.annual.eq(ZERO)) continue;
    const sid = line.subjectId;
    allocatedBySubject.set(sid, (allocatedBySubject.get(sid) ?? ZERO).plus(line.annual));
  }

  if (lumpSum) {
    if (allocatedBySubject.size === 0) return;
    const requestTotal = sumAmounts([...allocatedBySubject.values()]);
    const projectBudget = await tx.projectBudget.findUnique({ where: { projectId } });
    if (!projectBudget) {
      throw new HTTPError(422, '项目总预算不存在,请先完成初始预算编制并审批');
    }
    const annuals = await tx.annualBudget.aggregate({
      where: { projectId },
      _sum: { currentAmount: true },
    });
    const total = fromStored(projectBudget.currentAmount);
    const allocated = fromStored(annuals._sum.currentAmount ?? '0');
    const pool = total.minus(allocated);
    if (requestTotal.gt(pool)) {
      throw new HTTPError(
        422,
        `超出项目未分配额度:剩余 ${pool.toFixed(2)}(总预算 ${total.toFixed(2)} − 历年已分配年度预算 ${allocated.toFixed(2)}),本次申请 ${requestTotal.toFixed(2)}`,
      );
    }
    return;
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
  // §包干制:总维度调整额必须为 0(无科目总预算层)。
  await assertAnnualOnlyForLumpSum(prisma, projectId, parsedLines);

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
 * §7 编辑调整草稿(DRAFT / REJECTED 可改):重建明细行 + 更新年度/原因。
 * 校验逻辑与 createAdjustment 一致;不涉及锁(驳回时锁已释放,DRAFT 本无锁)。
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
    // 行锁:与提交互斥(§codex P2——驳回单被并发编辑+提交时,校验必须基于同一份明细)。
    await tx.$queryRaw`SELECT id FROM budget_adjustments WHERE id = ${adjId}::uuid FOR UPDATE`;
    const existing = await tx.budgetAdjustment.findUnique({ where: { id: adjId } });
    if (!existing) {
      throw new HTTPError(404, '调整单不存在');
    }
    if (existing.status !== ApprovalStatus.DRAFT && existing.status !== ApprovalStatus.REJECTED) {
      throw new HTTPError(409, `仅草稿或已驳回单可编辑,当前状态:${existing.status}`);
    }
    const projectId = existing.projectId;

    // §包干制:总维度调整额必须为 0(无科目总预算层)。
    await assertAnnualOnlyForLumpSum(tx, projectId, parsedLines);

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
    include: { lines: { orderBy: { id: 'asc' } }, locks: true },
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
    include: { lines: { orderBy: { id: 'asc' } }, locks: true },
  });
  if (!adj) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'project:view', adj.projectId);
  return adj;
}

// ------------------------------------------------------------
// §issue15 审批详情:科目行原预算/调整额/调整后金额(基线重建与导出共用)。
// ------------------------------------------------------------

/** 单行详情(金额均为元字符串,2 位小数)。 */
export interface AdjustmentLineDetail {
  id: string;
  /** 现有科目 id;新增科目行为 null。 */
  subjectId: string | null;
  /** 科目名(新增科目行 = null,展示 newSubjectName)。 */
  subjectName: string | null;
  subjectCode: string | null;
  isNew: boolean;
  newSubjectName: string | null;
  /** 新增科目挂靠的父节点名(服务端解析,免前端再查)。 */
  newSubjectParentName: string | null;
  totalAdjustment: string;
  annualAdjustment: string;
  /** 审批/提交时点前的基线原值(待审单 = 提交时刻快照)。 */
  originTotal: string;
  originAnnual: string;
  /** 调整后 = 原值 + 调整额。 */
  afterTotal: string;
  afterAnnual: string;
}

/** 审批流转记录条目(§审批记录保留与展示)。 */
export interface AdjustmentHistoryEntry {
  action: string;
  operatorName: string;
  operatedAt: Date;
  /** 审批/驳回意见(无则为 null)。 */
  opinion: string | null;
}

/** 调整单详情(明细行 + 双维度合计)。 */
export interface AdjustmentDetail {
  id: string;
  projectId: string;
  year: number;
  kind: 'ADJUST' | 'ALLOCATE';
  expandTotals: boolean;
  status: string;
  totalReason: string | null;
  annualReason: string | null;
  createdAt: Date;
  /** 最近一次驳回意见(从未被驳回则为 null)。 */
  rejectionOpinion: string | null;
  rejectionAt: Date | null;
  /** 审批流转记录(审计日志:新建/修改/提交/审批/驳回/撤回,含意见与操作人)。 */
  history: AdjustmentHistoryEntry[];
  lines: AdjustmentLineDetail[];
  sums: {
    originTotal: string;
    originAnnual: string;
    adjustTotal: string;
    adjustAnnual: string;
    afterTotal: string;
    afterAnnual: string;
  };
}

/**
 * 审批详情(§issue15):在 getAdjustment 权限校验之上,额外重建每行的
 * 原预算基线(待审单取提交时刻快照,已生效单取审批前),供审批人对照决策。
 */
export async function getAdjustmentDetail(
  adjId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<AdjustmentDetail> {
  const adj = await getAdjustment(adjId, user);

  const [subjects, baseline] = await Promise.all([
    prisma.budgetSubject.findMany({
      where: {
        id: {
          in: adj.lines
            .flatMap((l) => [l.subjectId, l.newSubjectParentId])
            .filter((v): v is string => !!v),
        },
      },
      select: { id: true, name: true, code: true, parentId: true, createdAt: true },
    }),
    // 待审/草稿:参照最近提交时刻(驳回后再提交会刷新 submittedAt);
    // 已生效:参照审批时刻(undefined → 内部取 approvedAt)。
    buildBaselineAmounts(
      adj,
      adj.status === 'APPROVED' ? undefined : (adj.submittedAt ?? adj.createdAt),
    ),
  ]);
  const subjectById = new Map(subjects.map((s) => [s.id, s]));

  // 本单新设科目(§codex P1,与导出口径一致):原预算恒为 0——科目因本单而生,
  // 此前无账。新数据审批已回写 subjectId;历史单据按(父节点,名称)解析。
  const bornSubjectIds = new Set<string>();
  if (adj.status === 'APPROVED' && adj.approvedAt) {
    for (const l of adj.lines) {
      if (!l.newSubjectName) continue;
      if (l.subjectId) {
        bornSubjectIds.add(l.subjectId);
        continue;
      }
      // 不加 createdAt 截断:approvedAt 取自事务前时钟,科目 createdAt 是事务内
      // DB 时钟,必然晚于 approvedAt,截断会恰好排除目标科目。(父节点,名称)
      // 在同父下唯一(validateNewSubject 保证),匹配安全。
      const born = subjects.find(
        (s) => s.parentId === l.newSubjectParentId && s.name === l.newSubjectName,
      );
      if (born) bornSubjectIds.add(born.id);
    }
  }

  // §codex P2:同一科目可出现在多行(表单允许、服务端接受)。审批生效是按科目
  // 累加 delta,详情必须按科目聚合展示——逐行各配一份完整基线会让"原预算/调整后"
  // 合计虚增,行级调整后也与审批后余额对不上。新增科目行按(父节点,名称)分组。
  const grouped = new Map<string, { first: (typeof adj.lines)[number]; total: D; annual: D }>();
  for (const l of adj.lines) {
    const key = l.subjectId ?? `new:${l.newSubjectParentId}:${l.newSubjectName}`;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.total = bucket.total.plus(fromStored(String(l.totalAdjustment)));
      bucket.annual = bucket.annual.plus(fromStored(String(l.annualAdjustment)));
    } else {
      grouped.set(key, {
        first: l,
        total: fromStored(String(l.totalAdjustment)),
        annual: fromStored(String(l.annualAdjustment)),
      });
    }
  }

  const lines: AdjustmentLineDetail[] = [...grouped.values()].map(({ first: l, total, annual }) => {
    const isNew = !l.subjectId;
    const born = !isNew && bornSubjectIds.has(l.subjectId!);
    const originTotal = isNew || born ? ZERO : (baseline.total.get(l.subjectId!) ?? ZERO);
    const originAnnual = isNew || born ? ZERO : (baseline.annual.get(l.subjectId!) ?? ZERO);
    const parent = l.newSubjectParentId ? subjectById.get(l.newSubjectParentId) : undefined;
    const subj = l.subjectId ? subjectById.get(l.subjectId) : undefined;
    return {
      id: l.id,
      subjectId: l.subjectId,
      subjectName: subj?.name ?? null,
      subjectCode: subj?.code ?? null,
      isNew,
      newSubjectName: l.newSubjectName,
      newSubjectParentName: parent?.name ?? null,
      totalAdjustment: total.toFixed(2),
      annualAdjustment: annual.toFixed(2),
      originTotal: originTotal.toFixed(2),
      originAnnual: originAnnual.toFixed(2),
      afterTotal: originTotal.plus(total).toFixed(2),
      afterAnnual: originAnnual.plus(annual).toFixed(2),
    };
  });

  const sumBy = (pick: (l: AdjustmentLineDetail) => string) =>
    lines.reduce((acc, l) => acc.plus(fromStored(pick(l))), ZERO).toFixed(2);

  // 审批流转记录(§审批记录保留与展示):审计日志按时间升序,含操作人。
  const historyRows = await prisma.auditLog.findMany({
    where: {
      objectType: 'budget_adjustments',
      objectId: adj.id,
      action: { in: ['create', 'update', 'submit', 'approve', 'reject', 'withdraw'] },
    },
    // operated_at 为毫秒精度,同毫秒双写时以 uuidv7 id(时间有序)作稳定次序键。
    orderBy: [{ operatedAt: 'asc' }, { id: 'asc' }],
    include: { operator: { select: { name: true } } },
  });
  const history: AdjustmentHistoryEntry[] = historyRows.map((h) => ({
    action: h.action,
    operatorName: h.operator?.name ?? '—',
    operatedAt: h.operatedAt,
    opinion: ((h.afterData as { opinion?: unknown } | null)?.opinion as string | undefined) ?? null,
  }));
  // 最近一次驳回意见 = 流转记录中最后一条 reject 的意见。
  const lastRejection = [...history].reverse().find((h) => h.action === 'reject');
  const rejectionOpinion = lastRejection?.opinion ?? null;

  return {
    id: adj.id,
    projectId: adj.projectId,
    year: adj.year,
    kind: adj.kind,
    expandTotals: adj.expandTotals,
    status: adj.status,
    totalReason: adj.totalReason,
    annualReason: adj.annualReason,
    createdAt: adj.createdAt,
    rejectionOpinion,
    rejectionAt: lastRejection?.operatedAt ?? null,
    history,
    lines,
    sums: {
      originTotal: sumBy((l) => l.originTotal),
      originAnnual: sumBy((l) => l.originAnnual),
      adjustTotal: sumBy((l) => l.totalAdjustment),
      adjustAnnual: sumBy((l) => l.annualAdjustment),
      afterTotal: sumBy((l) => l.afterTotal),
      afterAnnual: sumBy((l) => l.afterAnnual),
    },
  };
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
  const adjRef = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    select: { projectId: true },
  });
  if (!adjRef) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:adjust', adjRef.projectId);

  // 读单/守卫/解析全部移入事务并先锁单行(§codex P2):与并发编辑互斥,
  // 校验/锁/状态迁移基于同一份明细与状态。
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM budget_adjustments WHERE id = ${adjId}::uuid FOR UPDATE`;
    const adj = await tx.budgetAdjustment.findUnique({
      where: { id: adjId },
      include: { lines: true },
    });
    if (!adj) {
      throw new HTTPError(404, '调整单不存在');
    }

    // DRAFT 首次提交;REJECTED 驳回后修改可再次提交(锁已在驳回时释放,此处重建)。
    if (adj.status !== ApprovalStatus.DRAFT && adj.status !== ApprovalStatus.REJECTED) {
      throw new HTTPError(409, `当前状态 ${adj.status} 不可提交,仅 草稿/已驳回 可提交`);
    }

    const parsedLines = adj.lines.map((l) => ({
      id: l.id,
      subjectId: l.subjectId,
      newSubjectName: l.newSubjectName,
      newSubjectParentId: l.newSubjectParentId,
      total: fromStored(l.totalAdjustment),
      annual: fromStored(l.annualAdjustment),
    }));

    // 并发复核预期 = 提交前的状态(DRAFT 首次提交 / REJECTED 驳回后再提交)。
    const expectedStatus = adj.status;
    if (adj.kind === AdjustmentKind.ALLOCATE) {
      // 追加下达:正向 + 非零合计;池内分配再做容量护栏(expandTotals 不设上限);无锁、无零和校验。
      validateAllocate(parsedLines);
      await lockAndRecheckStatus(tx, adjId, expectedStatus);
      if (!adj.expandTotals) {
        await assertAllocateCapacity(tx, adj.projectId, parsedLines);
      }
      const submitted = await tx.budgetAdjustment.update({
        where: { id: adjId },
        data: { status: ApprovalStatus.PENDING, submittedAt: new Date() },
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
    }

    assertBalanced(parsedLines);
    // 新增科目行原预算为 0,调减无意义(应只调增)。
    for (const line of parsedLines) {
      if (!line.subjectId && (line.total.isNeg() || line.annual.isNeg())) {
        throw new HTTPError(422, `新增科目"${line.newSubjectName}"原预算为 0,不可调减`);
      }
    }

    await lockAndRecheckStatus(tx, adjId, expectedStatus);
    // 总维度调减护栏:调整后不得为负(§总维度调减护栏)。
    await assertTotalDecreaseFloor(tx, adj.projectId, null, parsedLines);
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
      data: { status: ApprovalStatus.PENDING, submittedAt: new Date() },
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
 * 账本恒等式断言(§issue12 写入防线):current = initial + adjustment。
 * 任一写入路径破坏该恒等式(历史上曾致导出审批表金额翻倍)立即回滚。
 */
function assertLedgerIdentity(initial: D, adjustment: D, current: D, label: string): void {
  if (!current.minus(initial).minus(adjustment).abs().lte(fromStored('0.005'))) {
    throw new HTTPError(
      500,
      `${label} 恒等式破坏:current(${current.toFixed(2)}) ≠ initial(${initial.toFixed(2)}) + adjustment(${adjustment.toFixed(2)}),已回滚`,
    );
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
  /** 审批人所见版本的提交代:与锁内单据不符 → 409(§codex P1 版本绑定)。 */
  clientSubmittedAt?: string | null,
): Promise<BudgetAdjustment> {
  // 首读仅取权限/状态/提交代;全量(明细)在事务内行锁后重读。
  // §codex P1:提交代(submittedAt)绑定——待审期间被驳回/编辑/再提交时,
  // 本审批在行锁内发现代变化即 409,绝不把旧提交的明细套在新提交上执行。
  const adjRef = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    select: { projectId: true, status: true, submittedAt: true },
  });
  if (!adjRef) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:approve', adjRef.projectId);

  if (adjRef.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${adjRef.status} 不可审批,仅 PENDING 可审批`);
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // 双重审批防护:行锁 + 锁内复核状态(两个并发审批只有一个能通过);
    // 即使复核被绕过,末尾的条件化状态迁移 + 事务回滚仍保证金额不重复应用。
    await tx.$queryRaw`SELECT id FROM budget_adjustments WHERE id = ${adjId}::uuid FOR UPDATE`;
    const adj = await tx.budgetAdjustment.findUnique({
      where: { id: adjId },
      include: { lines: true },
    });
    if (!adj) {
      throw new HTTPError(404, '调整单不存在');
    }
    if (adj.status !== ApprovalStatus.PENDING) {
      throw new HTTPError(409, `当前状态 ${adj.status} 不可审批,仅 PENDING 可审批`);
    }
    if ((adjRef.submittedAt?.getTime() ?? 0) !== (adj.submittedAt?.getTime() ?? 0)) {
      throw new HTTPError(409, '该调整单在审批期间被驳回并重新提交,请刷新后重试');
    }

    // §codex P1:客户端携带其所见版本的提交代时,必须与锁内单据一致——
    // 审批人打开的是旧轮次而单据已被驳回/再提交 → 拒绝,防止批准未审阅的内容。
    if (
      clientSubmittedAt &&
      (adj.submittedAt?.getTime() ?? 0) !== new Date(clientSubmittedAt).getTime()
    ) {
      throw new HTTPError(409, '该调整单已变更(被驳回或重新提交),请刷新后基于最新版本操作');
    }
    await lockAndRecheckStatus(tx, adjId, ApprovalStatus.PENDING);
    // §包干制:无科目总预算层——新增科目不建 STB,expandTotals 不调 STB,
    // 总维度 delta 由创建/编辑入口保证恒 0(此处循环自然空转)。
    const lumpSum =
      (
        await tx.project.findUnique({
          where: { id: adj.projectId },
          select: { budgetMode: true },
        })
      )?.budgetMode === 'LUMP_SUM';
    const parsedLines = adj.lines.map((l) => ({
      id: l.id,
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

      // 前提复核:初始预算编制必须已审批生效。否则后续编制审批会 current←initial
      // 整体重置,静默清掉本次追加的额度(此前仅前端门控,API 可绕过)。
      const initApp = await tx.initialBudgetApplication.findUnique({
        where: { projectId: adj.projectId },
        select: { status: true },
      });
      if (!initApp || initApp.status !== ApprovalStatus.APPROVED) {
        throw new HTTPError(
          422,
          `初始预算编制尚未审批生效(当前:${initApp?.status ?? '无'}),不可追加下达`,
        );
      }

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
        const newParentId = line.newSubjectParentId;
        const parent = newParentId
          ? await tx.budgetSubject.findUnique({
              where: { id: newParentId },
              select: { level: true },
            })
          : null;
        const newSubjectId = uuidv7();
        await tx.budgetSubject.create({
          data: {
            id: newSubjectId,
            projectId: adj.projectId,
            parentId: newParentId, // null = 一级科目
            code: uuidv7(),
            name: line.newSubjectName!,
            level: (parent?.level ?? 0) + 1,
            isLeaf: true,
            sortOrder: nextSort++,
          },
        });
        // 叶父节点挂上首个子科目后转为非叶(预算由子科目汇总;无预算叶已过校验)。
        if (newParentId) {
          await tx.budgetSubject.update({
            where: { id: newParentId },
            data: { isLeaf: false },
          });
        }
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
        // §包干制:不建 STB(LUMP_SUM 无科目总预算层)。
        if (!lumpSum) {
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
        }
        line.subjectId = newSubjectId;
        // 回写明细行 subjectId:导出/详情按科目口径渲染时不再重复成行。
        await tx.budgetAdjustmentLine.update({
          where: { id: line.id },
          data: { subjectId: newSubjectId },
        });
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
          const sbInitial = fromStored(sb.initialAmount);
          const sbAdjustment = fromStored(sb.adjustmentAmount).plus(line.annual);
          const sbCurrent = fromStored(sb.currentAmount).plus(line.annual);
          assertLedgerIdentity(sbInitial, sbAdjustment, sbCurrent, '科目年度预算');
          await tx.subjectBudget.update({
            where: { id: sb.id },
            data: {
              currentAmount: toStored(sbCurrent),
              adjustmentAmount: toStored(sbAdjustment),
            },
          });
        }
      }

      // 2.5) expandTotals(新经费入账):现有科目的总预算随下达额同步调增。
      //      (isNew 行第 1 步已按首笔分配额立账;池内模式则不动 STB。)
      //      §包干制:整体跳过(无科目总预算层,经费只入项目总盘 + 年度盘子)。
      if (adj.expandTotals && !lumpSum) {
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
            const stbInitial = fromStored(stb.initialAmount);
            const stbAdjustment = fromStored(stb.adjustmentAmount).plus(line.annual);
            const stbCurrent = fromStored(stb.currentAmount).plus(line.annual);
            assertLedgerIdentity(stbInitial, stbAdjustment, stbCurrent, '科目总预算');
            await tx.subjectTotalBudget.update({
              where: { id: stb.id },
              data: {
                currentAmount: toStored(stbCurrent),
                adjustmentAmount: toStored(stbAdjustment),
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
        const nextInitial = yearTotal;
        const nextAdjustment = ZERO;
        const nextCurrent = yearTotal;
        assertLedgerIdentity(nextInitial, nextAdjustment, nextCurrent, `年度预算(${adj.year})`);
        await tx.annualBudget.create({
          data: {
            id: uuidv7(),
            projectId: adj.projectId,
            year: adj.year,
            initialAmount: toStored(nextInitial),
            adjustmentAmount: toStored(nextAdjustment),
            currentAmount: toStored(nextCurrent),
          },
        });
      } else {
        const nextInitial = fromStored(annualBudget.initialAmount);
        const nextAdjustment = fromStored(annualBudget.adjustmentAmount).plus(yearTotal);
        const nextCurrent = fromStored(annualBudget.currentAmount).plus(yearTotal);
        assertLedgerIdentity(nextInitial, nextAdjustment, nextCurrent, `年度预算(${adj.year})`);
        await tx.annualBudget.update({
          where: { id: annualBudget.id },
          data: {
            adjustmentAmount: toStored(nextAdjustment),
            currentAmount: toStored(nextCurrent),
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
        const pbInitial = fromStored(projectBudget.initialAmount);
        const pbAdjustment = fromStored(projectBudget.adjustmentAmount).plus(yearTotal);
        const pbCurrent = fromStored(projectBudget.currentAmount).plus(yearTotal);
        assertLedgerIdentity(pbInitial, pbAdjustment, pbCurrent, '项目总预算');
        await tx.projectBudget.update({
          where: { projectId: adj.projectId },
          data: {
            adjustmentAmount: toStored(pbAdjustment),
            currentAmount: toStored(pbCurrent),
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
      // 校验父节点(无预算叶亦可)+ 重名(草稿后可能已被改)。
      await validateNewSubject(tx, adj.projectId, line.newSubjectName!, line.newSubjectParentId!);
      const newParentId = line.newSubjectParentId;
      const parent = newParentId
        ? await tx.budgetSubject.findUnique({ where: { id: newParentId }, select: { level: true } })
        : null;
      const newSubjectId = uuidv7();
      await tx.budgetSubject.create({
        data: {
          id: newSubjectId,
          projectId: adj.projectId,
          parentId: newParentId, // null = 一级科目
          code: uuidv7(), // 项目内唯一(用 uuid 兜底)
          name: line.newSubjectName!,
          level: (parent?.level ?? 0) + 1,
          isLeaf: true,
          sortOrder: nextSort++,
        },
      });
      // 叶父节点挂上首个子科目后转为非叶(预算由子科目汇总;无预算叶已过校验)。
      if (newParentId) {
        await tx.budgetSubject.update({
          where: { id: newParentId },
          data: { isLeaf: false },
        });
      }
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
      // §包干制:不建(LUMP_SUM 无科目总预算层)。
      if (!lumpSum) {
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
      }
      line.subjectId = newSubjectId;
      // 回写明细行 subjectId(§issue16 导出防重复成行;提交时已建,审批前作废亦无害)。
      await tx.budgetAdjustmentLine.update({
        where: { id: line.id },
        data: { subjectId: newSubjectId },
      });
    }

    // 总维度调减护栏(审批时兜底):以事务内实时余额复核,并发审批先批的单
    // 挤占额度后,本单投影为负则整单回滚(§总维度调减护栏)。
    await assertTotalDecreaseFloor(tx, adj.projectId, adj.id, parsedLines);

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
      assertLedgerIdentity(
        fromStored(sb.initialAmount),
        nextAdj,
        next,
        `科目年度预算(${adj.year})`,
      );
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
        assertLedgerIdentity(fromStored(stb.initialAmount), nextAdj, next, '科目总预算');
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
  /** 审批人所见版本的提交代(§codex P1 版本绑定)。 */
  clientSubmittedAt?: string | null,
): Promise<BudgetAdjustment> {
  // 提交代绑定同 approve(§codex P1):待审期间被再提交则拒绝本次驳回。
  const adjRef = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    select: { projectId: true, status: true, submittedAt: true },
  });
  if (!adjRef) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:approve', adjRef.projectId);

  if (adjRef.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${adjRef.status} 不可驳回,仅 PENDING 可驳回`);
  }
  if (!opinion || !opinion.trim()) {
    throw new HTTPError(422, '驳回需填写意见');
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM budget_adjustments WHERE id = ${adjId}::uuid FOR UPDATE`;
    const adj = await tx.budgetAdjustment.findUnique({ where: { id: adjId } });
    if (!adj) {
      throw new HTTPError(404, '调整单不存在');
    }
    if (adj.status !== ApprovalStatus.PENDING) {
      throw new HTTPError(409, `当前状态 ${adj.status} 不可驳回,仅 PENDING 可驳回`);
    }
    if ((adjRef.submittedAt?.getTime() ?? 0) !== (adj.submittedAt?.getTime() ?? 0)) {
      throw new HTTPError(409, '该调整单在审批期间被重新提交,请刷新后重试');
    }

    if (
      clientSubmittedAt &&
      (adj.submittedAt?.getTime() ?? 0) !== new Date(clientSubmittedAt).getTime()
    ) {
      throw new HTTPError(409, '该调整单已变更(被重新提交),请刷新后重试');
    }
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
  /** 操作人所见版本的提交代(§codex P1 版本绑定)。 */
  clientSubmittedAt?: string | null,
): Promise<BudgetAdjustment> {
  // 提交代绑定同 approve(§codex P1):待审期间被驳回/再提交则拒绝本次撤回。
  const adjRef = await prisma.budgetAdjustment.findUnique({
    where: { id: adjId },
    select: { projectId: true, status: true, submittedAt: true },
  });
  if (!adjRef) {
    throw new HTTPError(404, '调整单不存在');
  }
  await requirePermission(user, 'budget:adjust', adjRef.projectId);

  if (adjRef.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${adjRef.status} 不可撤回,仅 PENDING 可撤回`);
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM budget_adjustments WHERE id = ${adjId}::uuid FOR UPDATE`;
    const adj = await tx.budgetAdjustment.findUnique({ where: { id: adjId } });
    if (!adj) {
      throw new HTTPError(404, '调整单不存在');
    }
    if (adj.status !== ApprovalStatus.PENDING) {
      throw new HTTPError(409, `当前状态 ${adj.status} 不可撤回,仅 PENDING 可撤回`);
    }
    if ((adjRef.submittedAt?.getTime() ?? 0) !== (adj.submittedAt?.getTime() ?? 0)) {
      throw new HTTPError(409, '该调整单在审批期间状态发生变化,请刷新后重试');
    }

    if (
      clientSubmittedAt &&
      (adj.submittedAt?.getTime() ?? 0) !== new Date(clientSubmittedAt).getTime()
    ) {
      throw new HTTPError(409, '该调整单状态已变化,请刷新后重试');
    }
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
