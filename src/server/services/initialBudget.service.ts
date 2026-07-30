import { ApprovalStatus, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, sumAmounts, toStored } from '@/lib/decimal';
import { recordAudit } from '@/server/audit/interceptor';

/**
 * §6 编制单入参(payload 来自表单)。
 * - 金额统一为 decimal 字符串(JSON 传输,§global 约定)。
 * - 科目在 payload 内引用 parentCode(此时尚无 id),由 service 在事务内解析。
 * - subjectBudgets 只允许引用 isLeaf=true 的科目。
 */
export interface InitialBudgetPayload {
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description?: string;
  }[];
  subjectBudgets: { year: number; subjectCode: string; amount: string }[];
}

/** getDraft 返回结构:便于表单回填再编辑(扁平 + 树引用 parentCode)。 */
export interface InitialBudgetDraftView {
  id: string;
  projectId: string;
  status: ApprovalStatus;
  applicantId: string;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    id: string;
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description: string | null;
  }[];
  subjectBudgets: {
    year: number;
    subjectCode: string;
    amount: string;
  }[];
}

/**
 * §6.4 提交校验(失败统一抛 HTTPError 422):
 * - 总预算非负
 * - 年度合计 ≤ 总预算
 * - 同年度叶节点合计 ≤ 该年度初始预算
 * - 叶节点编码项目内唯一(此处 payload 内 unique)
 * - 初始预算只允许填在叶节点
 */
function validatePayload(payload: InitialBudgetPayload): void {
  const projectTotal = new D(payload.projectTotal);

  // 0) year 必须是合理的正整数(1900~9999),覆盖 annualBudgets 与 subjectBudgets。
  const isSaneYear = (y: unknown): boolean =>
    typeof y === 'number' && Number.isInteger(y) && y >= 1900 && y <= 9999;
  for (const ab of payload.annualBudgets) {
    if (!isSaneYear(ab.year)) {
      throw new HTTPError(422, `年度 ${ab.year} 不是有效的正整数(1900~9999)`);
    }
  }
  for (const sb of payload.subjectBudgets) {
    if (!isSaneYear(sb.year)) {
      throw new HTTPError(
        422,
        `科目 ${sb.subjectCode} 的年度 ${sb.year} 不是有效的正整数(1900~9999)`,
      );
    }
  }

  // 1) 项目初始总预算不得为负。
  if (!projectTotal.gte(ZERO)) {
    throw new HTTPError(422, '项目初始总预算不得为负');
  }

  // 2) 科目编码项目内(payload 内)唯一。
  const codes = payload.subjects.map((s) => s.code);
  const codeSet = new Set(codes);
  if (codeSet.size !== codes.length) {
    throw new HTTPError(422, '科目编码在项目内不唯一');
  }

  // 3) parentCode 必须指向 payload 内已存在科目(且不能形成自环)。
  for (const s of payload.subjects) {
    if (s.parentCode !== null && !codeSet.has(s.parentCode)) {
      throw new HTTPError(422, `科目 ${s.code} 的父编码 ${s.parentCode} 不存在`);
    }
    if (s.parentCode === s.code) {
      throw new HTTPError(422, `科目 ${s.code} 的父编码不能指向自身`);
    }
  }

  const leafCodes = new Set(payload.subjects.filter((s) => s.isLeaf).map((s) => s.code));

  // 4) 初始预算只允许填在叶节点。
  for (const sb of payload.subjectBudgets) {
    if (!leafCodes.has(sb.subjectCode)) {
      throw new HTTPError(422, `科目 ${sb.subjectCode} 不是叶节点,初始预算只允许填在叶节点`);
    }
  }

  // 5) 各年度初始预算合计不得超过项目初始总预算。
  const annualByYear = new Map<number, D>();
  for (const ab of payload.annualBudgets) {
    const amt = new D(ab.amount);
    if (!amt.gte(ZERO)) {
      throw new HTTPError(422, `年度 ${ab.year} 预算不得为负`);
    }
    annualByYear.set(ab.year, (annualByYear.get(ab.year) ?? ZERO).plus(amt));
  }
  const annualTotal = sumAmounts([...annualByYear.values()]);
  if (annualTotal.gt(projectTotal)) {
    throw new HTTPError(422, '各年度初始预算合计不得超过项目初始总预算');
  }

  // 6) 同年度叶节点初始预算合计不得超过该年度初始预算。
  for (const [year, annualAmount] of annualByYear.entries()) {
    const leafSum = sumAmounts(
      payload.subjectBudgets.filter((sb) => sb.year === year).map((sb) => new D(sb.amount)),
    );
    if (leafSum.gt(annualAmount)) {
      throw new HTTPError(422, `${year} 年叶节点初始预算合计不得超过该年度初始预算`);
    }
  }

  // subjectBudgets 的 year 必须在 annualBudgets 范围内(否则上一步 leafSum 恒 ≤
  // 年度,但若年度未声明则无法比对;此处显式拒绝未声明年度的叶节点预算)。
  const declaredYears = new Set(annualByYear.keys());
  for (const sb of payload.subjectBudgets) {
    if (!declaredYears.has(sb.year)) {
      throw new HTTPError(422, `科目 ${sb.subjectCode} 的年度 ${sb.year} 未在年度预算中声明`);
    }
    if (!new D(sb.amount).gte(ZERO)) {
      throw new HTTPError(422, `科目 ${sb.subjectCode} 的预算不得为负`);
    }
  }
}

/**
 * 计算科目层级(根为 1)。payload 已校验过无环(parentCode 均在 codeSet 内且非自环),
 * 但需进一步检测间接环;若成环抛 422。
 */
function computeLevels(payload: InitialBudgetPayload): Map<string, number> {
  const parentOf = new Map(payload.subjects.map((s) => [s.code, s.parentCode]));
  const cache = new Map<string, number>();
  const resolve = (code: string, stack: Set<string>): number => {
    if (cache.has(code)) return cache.get(code)!;
    const parent = parentOf.get(code) ?? null;
    if (parent === null) {
      cache.set(code, 1);
      return 1;
    }
    if (stack.has(parent)) {
      throw new HTTPError(422, `科目 ${code} 的父链存在环`);
    }
    stack.add(code);
    const lvl = resolve(parent, stack) + 1;
    cache.set(code, lvl);
    return lvl;
  };
  for (const s of payload.subjects) {
    resolve(s.code, new Set());
  }
  return cache;
}

/**
 * §6 编制草稿:createDraft。
 * - 权限:budget:editInitial + 项目范围。
 * - 一个项目仅允许一份编制(任意状态)存在,重复抛 409。
 * - §6.4 校验失败抛 422。
 * - 事务内:建 application(DRAFT)+ 科目树(two-pass 解析 parentCode)
 *   + subject_budgets / annual_budgets(initial=金额,current=0,§6.3 审批生效才置位)
 *   + ProjectBudget.initialAmount + 审计。
 */
export async function createDraft(
  projectId: string,
  payload: InitialBudgetPayload,
  user: Pick<User, 'id' | 'role'>,
): Promise<{ appId: string }> {
  await requirePermission(user, 'budget:editInitial', projectId);

  // 一个项目仅允许一份编制(任意状态)。
  const existing = await prisma.initialBudgetApplication.findFirst({
    where: { projectId },
    select: { id: true },
  });
  if (existing) {
    throw new HTTPError(409, '该项目已存在编制单,一个项目仅允许一份初始预算编制');
  }

  // 项目必须存在(避免悬空外键)。
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, archivedAt: true },
  });
  if (!project) {
    throw new HTTPError(404, '项目不存在');
  }
  if (project.archivedAt) {
    throw new HTTPError(409, '项目已归档,不可编制预算');
  }

  validatePayload(payload);
  const levels = computeLevels(payload);

  const projectTotal = new D(payload.projectTotal);
  const appId = uuidv7();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.initialBudgetApplication.create({
        data: {
          id: appId,
          projectId,
          status: ApprovalStatus.DRAFT,
          applicantId: user.id,
        },
      });

      // Pass 1:全部科目以 parentId=null 落库,记录 code → id。
      const codeToId = new Map<string, string>();
      for (const s of payload.subjects) {
        const id = uuidv7();
        codeToId.set(s.code, id);
        await tx.budgetSubject.create({
          data: {
            id,
            projectId,
            parentId: null,
            code: s.code,
            name: s.name,
            description: s.description ?? null,
            level: levels.get(s.code) ?? 1,
            isLeaf: s.isLeaf,
          },
        });
      }

      // Pass 2:为非根科目回填 parentId。
      for (const s of payload.subjects) {
        if (s.parentCode === null) continue;
        const childId = codeToId.get(s.code)!;
        const parentId = codeToId.get(s.parentCode)!;
        await tx.budgetSubject.update({
          where: { id: childId },
          data: { parentId },
        });
      }

      // 年度预算:upsert。§6.3 审批通过前不影响当前预算 → initial = 年度金额,
      // current = 0(审批生效才置位,与 ProjectBudget 处理一致)。
      for (const ab of payload.annualBudgets) {
        const amt = new D(ab.amount);
        await tx.annualBudget.upsert({
          where: { projectId_year: { projectId, year: ab.year } },
          update: {
            initialAmount: toStored(amt),
            adjustmentAmount: toStored(ZERO),
            currentAmount: toStored(ZERO),
          },
          create: {
            id: uuidv7(),
            projectId,
            year: ab.year,
            initialAmount: toStored(amt),
            adjustmentAmount: toStored(ZERO),
            currentAmount: toStored(ZERO),
          },
        });
      }

      // 叶节点预算:initial = 金额,current = 0(§6.3 同上,只允许 isLeaf)。
      for (const sb of payload.subjectBudgets) {
        const subjectId = codeToId.get(sb.subjectCode);
        if (!subjectId) {
          // 不应发生(validatePayload 已校验);防御性抛错。
          throw new HTTPError(422, `科目 ${sb.subjectCode} 不存在`);
        }
        const amt = new D(sb.amount);
        await tx.subjectBudget.upsert({
          where: {
            projectId_year_subjectId: { projectId, year: sb.year, subjectId },
          },
          update: {
            initialAmount: toStored(amt),
            adjustmentAmount: toStored(ZERO),
            currentAmount: toStored(ZERO),
          },
          create: {
            id: uuidv7(),
            projectId,
            year: sb.year,
            subjectId,
            initialAmount: toStored(amt),
            adjustmentAmount: toStored(ZERO),
            currentAmount: toStored(ZERO),
          },
        });
      }

      // 项目总预算 initialAmount 回填(current 仍由审批生效才置位,§6.3)。
      await tx.projectBudget.update({
        where: { projectId },
        data: { initialAmount: toStored(projectTotal) },
      });

      await recordAudit(tx, {
        projectId,
        objectType: 'initial_budget_applications',
        objectId: appId,
        action: 'create',
        operatorId: user.id,
        after: {
          projectTotal: projectTotal.toFixed(2),
          subjectCount: payload.subjects.length,
          annualYears: payload.annualBudgets.map((a) => a.year),
        },
      });
    });
  } catch (e) {
    // 并发重复编制:read-check 处理常见情况,唯一约束兜底竞态(§6.3)。
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new HTTPError(409, '该项目已存在编制单,一个项目仅允许一份初始预算编制');
    }
    throw e;
  }

  return { appId };
}

/**
 * §6 取编制草稿(含 subjects + budgets,扁平结构便于表单回填)。
 * 不存在时抛 404。
 */
export async function getDraft(
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<InitialBudgetDraftView> {
  await requirePermission(user, 'budget:editInitial', projectId);

  const app = await prisma.initialBudgetApplication.findFirst({
    where: { projectId },
    include: {
      project: { include: { projectBudget: true } },
    },
  });
  if (!app) {
    throw new HTTPError(404, '该项目尚无初始预算编制单');
  }

  const [subjects, annualBudgets, subjectBudgets] = await Promise.all([
    prisma.budgetSubject.findMany({
      where: { projectId },
      orderBy: { code: 'asc' },
      include: { parent: { select: { code: true } } },
    }),
    prisma.annualBudget.findMany({ where: { projectId }, orderBy: { year: 'asc' } }),
    prisma.subjectBudget.findMany({
      where: { projectId },
      orderBy: [{ year: 'asc' }, { subject: { code: 'asc' } }],
      include: { subject: { select: { code: true } } },
    }),
  ]);

  return {
    id: app.id,
    projectId: app.projectId,
    status: app.status,
    applicantId: app.applicantId,
    submittedAt: app.submittedAt,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    projectTotal: fromStored(app.project.projectBudget!.initialAmount).toFixed(2),
    annualBudgets: annualBudgets.map((a) => ({
      year: a.year,
      amount: fromStored(a.initialAmount).toFixed(2),
    })),
    subjects: subjects.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      parentCode: s.parent?.code ?? null,
      isLeaf: s.isLeaf,
      description: s.description,
    })),
    subjectBudgets: subjectBudgets.map((sb) => ({
      year: sb.year,
      subjectCode: sb.subject.code,
      amount: fromStored(sb.initialAmount).toFixed(2),
    })),
  };
}

/**
 * §6.2 提交编制单:DRAFT → PENDING,置 submittedAt,审计。
 * 非 DRAFT 状态提交抛 409;不存在抛 404;鉴权按项目范围。
 */
export async function submitDraft(
  appId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<{ appId: string; status: ApprovalStatus }> {
  const app = await prisma.initialBudgetApplication.findUnique({
    where: { id: appId },
    select: { id: true, projectId: true, status: true },
  });
  if (!app) {
    throw new HTTPError(404, '编制单不存在');
  }

  await requirePermission(user, 'budget:editInitial', app.projectId);

  if (app.status !== ApprovalStatus.DRAFT) {
    throw new HTTPError(409, `当前状态 ${app.status} 不可提交,仅 DRAFT 可提交`);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.initialBudgetApplication.update({
      where: { id: appId },
      data: { status: ApprovalStatus.PENDING, submittedAt: now },
    });
    await recordAudit(tx, {
      projectId: app.projectId,
      objectType: 'initial_budget_applications',
      objectId: appId,
      action: 'submit',
      operatorId: user.id,
      before: { status: ApprovalStatus.DRAFT },
      after: { status: ApprovalStatus.PENDING, submittedAt: now.toISOString() },
    });
  });

  return { appId, status: ApprovalStatus.PENDING };
}
