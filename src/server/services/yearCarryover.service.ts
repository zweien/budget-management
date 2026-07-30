import { BusinessStatus, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, toStored } from '@/lib/decimal';
import { computeOccupancy, adjustableAmount } from '@/lib/budget';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';

/**
 * §8.7 跨年结转:可结转的状态(非 PAID)。
 * PAID 已支出,不再结转(它已"花掉"原年度预算)。
 */
const CARRYOVER_STATUSES: readonly BusinessStatus[] = [
  BusinessStatus.PLACEHOLDER,
  BusinessStatus.CONTRACT,
  BusinessStatus.FINANCE_APPROVAL,
] as const;

/** §8.7 结转预警条目:某条记录在 toYear 缺预算或不可结转的说明。 */
export interface CarryoverWarning {
  originalRecordId: string;
  subjectCode: string;
  reason: string;
}

/** §8.7 carryOver 返回。 */
export interface CarryOverResult {
  carriedCount: number;
  warnings: CarryoverWarning[];
}

/** 校验年度为正整数(1900~9999)。 */
function assertValidYear(year: number, label: string): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new HTTPError(422, `${label} 必须是 1900~9999 的正整数`);
  }
}

/** 把 BusinessRecord 行序列化为快照对象(history before/after + 审计)。 */
function snapshotRecord(row: Record<string, unknown>): Record<string, unknown> {
  return snapshotRow(row);
}

/**
 * §8.7 跨年结转。
 * - 权限:record:create + 项目范围(结转属业务维护操作)。
 * - 取 fromYear 中状态非 PAID(PLACEHOLDER/CONTRACT/FINANCE_APPROVAL)且非作废的记录,
 *   在 toYear 同科目新建一条同金额、同状态、同经办人/摘要/业务日期的业务记录(结转记录)。
 * - 原记录保留(不修改、不作废),仅追加 history 行(action='carryover_out'),
 *   新记录追加 history 行(action='carryover_in',引用原 id);满足"可追溯 + 保留原年度归属"。
 * - §8.7 预警:若 toYear 该科目可用预算不足(amount > available)→ 加入 warnings,
 *   仍创建结转记录(超预算允许 §8.4),"不得静默丢失占用"。
 * - 全程在 prisma.$transaction 内执行;recordAudit 写结转审计。
 * - 返回 { carriedCount, warnings }。
 *
 * 注:科目为项目级(非年度级),故 toYear 科目一定存在;预警仅针对预算不足。
 */
export async function carryOver(
  projectId: string,
  fromYear: number,
  toYear: number,
  user: Pick<User, 'id' | 'role'>,
): Promise<CarryOverResult> {
  await requirePermission(user, 'record:create', projectId);

  assertValidYear(fromYear, 'fromYear');
  assertValidYear(toYear, 'toYear');
  if (fromYear === toYear) {
    throw new HTTPError(422, 'fromYear 与 toYear 不能相同');
  }
  if (fromYear >= toYear) {
    throw new HTTPError(422, 'fromYear 必须早于 toYear');
  }

  // 取 fromYear 待结转记录:非 PAID + 非作废。按 businessDate 升序处理(确定性)。
  const sources = await prisma.businessRecord.findMany({
    where: {
      projectId,
      budgetYear: fromYear,
      isVoid: false,
      status: { in: [...CARRYOVER_STATUSES] },
    },
    orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
  });

  if (sources.length === 0) {
    // 仍写一条结转"无操作对象"的审计,便于追溯(可选,但保留操作痕迹)。
    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, {
        projectId,
        objectType: 'business_records',
        objectId: projectId,
        action: 'carryover',
        operatorId: user.id,
        after: { fromYear, toYear, carriedCount: 0, note: '无可结转记录' },
      });
    });
    return { carriedCount: 0, warnings: [] };
  }

  const warnings: CarryoverWarning[] = [];

  const carriedCount = await prisma.$transaction(async (tx) => {
    let count = 0;

    // 按 subjectId 累计本批次已结转金额(用于多条同科目叠加预警)。
    const carriedAccumBySubject = new Map<string, D>();

    for (const src of sources) {
      const amount = fromStored(src.amount);

      // 在事务内查 toYear 该科目当前非作废记录(含本批次已插入),用于可用预算复算。
      const existingToYear = await tx.businessRecord.findMany({
        where: { projectId, budgetYear: toYear, subjectId: src.subjectId, isVoid: false },
      });
      const subjectBudget = await tx.subjectBudget.findUnique({
        where: {
          projectId_year_subjectId: { projectId, year: toYear, subjectId: src.subjectId },
        },
      });
      const currentBudget = subjectBudget ? fromStored(subjectBudget.currentAmount) : ZERO;
      const occ = computeOccupancy({
        records: existingToYear.map((r) => ({
          amount: r.amount,
          status: r.status,
          isVoid: r.isVoid,
        })),
      });
      const accum = carriedAccumBySubject.get(src.subjectId) ?? ZERO;
      // §8.7 可用预算 = 当前预算 - 已占用(adjustableAmount);若 amount > 可用 → 预警。
      const available = adjustableAmount(currentBudget, occ.totalOccupied);
      const budgetInsufficient = amount.plus(accum).gt(available);

      // 取科目编码(用于 warning 展示)。
      const subject = await tx.budgetSubject.findUnique({ where: { id: src.subjectId } });
      const subjectCode = subject?.code ?? src.subjectId;

      // 创建 toYear 新记录(结转记录)。
      const originalRemark = src.remark ?? '';
      const carryoverRemark = `[结转自${fromYear}]${originalRemark ? ` ${originalRemark}` : ''}`;
      const newId = uuidv7();
      const created = await tx.businessRecord.create({
        data: {
          id: newId,
          projectId,
          budgetYear: toYear,
          subjectId: src.subjectId,
          amount: toStored(amount),
          businessDate: src.businessDate,
          handler: src.handler,
          summary: src.summary,
          status: src.status,
          remark: carryoverRemark,
          isVoid: false,
          createdById: user.id,
        },
      });

      // 原记录追加 history:carryover_out(留痕,不改原记录本体)。
      await tx.businessRecordHistory.create({
        data: {
          id: uuidv7(),
          businessRecordId: src.id,
          action: 'carryover_out',
          beforeData: snapshotRecord(src) as Prisma.InputJsonValue,
          afterData: snapshotRecord(src) as Prisma.InputJsonValue,
          operatorId: user.id,
          reason: `结转至 ${toYear} 年记录 ${newId}`,
        },
      });

      // 新记录追加 history:carryover_in(引用原 id)。
      await tx.businessRecordHistory.create({
        data: {
          id: uuidv7(),
          businessRecordId: newId,
          action: 'carryover_in',
          beforeData: Prisma.JsonNull,
          afterData: snapshotRecord(created) as Prisma.InputJsonValue,
          operatorId: user.id,
          reason: `结转自 ${fromYear} 年记录 ${src.id}`,
        },
      });

      // 审计:对原记录写 carryover_out,对新记录写 carryover_in(同事务)。
      await recordAudit(tx, {
        projectId,
        objectType: 'business_records',
        objectId: src.id,
        action: 'carryover_out',
        operatorId: user.id,
        after: { toYear, carriedToRecordId: newId },
      });
      await recordAudit(tx, {
        projectId,
        objectType: 'business_records',
        objectId: newId,
        action: 'carryover_in',
        operatorId: user.id,
        after: { fromYear, carriedFromRecordId: src.id },
      });

      if (budgetInsufficient) {
        warnings.push({
          originalRecordId: src.id,
          subjectCode,
          reason: `toYear(${toYear}) 科目 ${subjectCode} 可用预算不足(需 ${amount.toFixed(
            2,
          )},可用 ${available.toFixed(2)}),记录已创建(§8.4 超预算允许),请人工确认`,
        });
      }

      carriedAccumBySubject.set(src.subjectId, accum.plus(amount));
      count += 1;
    }

    // 结转操作本身的汇总审计。
    await recordAudit(tx, {
      projectId,
      objectType: 'business_records',
      objectId: projectId,
      action: 'carryover',
      operatorId: user.id,
      after: { fromYear, toYear, carriedCount: count, warningCount: warnings.length },
    });

    return count;
  });

  return { carriedCount, warnings };
}
