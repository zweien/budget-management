/**
 * 迁移包(ADR 0003):单项目「项目信息 + 预算骨架」的可移植导出/导入。
 *
 * 包内容:项目、科目树、四层预算(项目/年度/科目×年度/科目总)、初始编制单、
 * 调整单(+明细行)、科目变更单;**不含**成员、业务记录、到账、附件、审计、凭证。
 * 保留原 ID,项目编号(code)为幂等键;User 引用按可空性分流(同 ID 保留 /
 * 必填重映射到导入操作者 / 可空置空),原操作人名字快照记入来源附注。
 *
 * 守卫:同编号冲突默认拒绝(--overwrite 仅限目标项目骨架态,非骨架态硬拒绝无绕过);
 * 版本偏差默认拒绝(--allow-skew);导出侧 PENDING 守卫见 exportPackage。
 * 导入为单事务全或无(BULK_TX_OPTIONS);导入后独立事务做汇总校验(沿用
 * recalc-summary-budgets 的科目层口径与 0.01 阈值:一般项目漂移自动修复,
 * 包干制只校验年度层、不盲改项目层)。
 *
 * 本服务仅由管理员本机 CLI(export-package / import-package)与测试调用,
 * 不暴露任何 HTTP/MCP 入口(红线见 AGENTS.md)。
 */
import { readFile } from 'node:fs/promises';

import { Prisma, type ApprovalStatus, type BudgetMode } from '@prisma/client';

import { uuidv7 } from '@/lib/id';
import { getAppVersion, getMigrationHead } from '@/lib/build-info';
import { BULK_TX_OPTIONS, prisma } from '@/lib/prisma';
import { findUsersByKey } from './userLookup.service';
import { verifyAndFixProjectSummaries, type SummaryVerifyResult } from './summaryRecalc.service';

export const MIGRATION_PACKAGE_FORMAT_VERSION = 1;
export const MIGRATION_PACKAGE_KIND = 'budget.migration-package';

/** 带详情的迁移错误:CLI 打印 message + details 列表。 */
export class MigrationError extends Error {
  details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'MigrationError';
    this.details = details;
  }
}

// ---------- 包数据结构(全 primitive,JSON 直存) ----------

interface MoneyTriple {
  initialAmount: string;
  adjustmentAmount: string;
  currentAmount: string;
}

export interface MigrationProjectData {
  id: string;
  code: string;
  name: string;
  level: string | null;
  projectType: string | null;
  undertakingUnit: string | null;
  startDate: string | null;
  endDate: string | null;
  ownerId: string;
  budgetMode: BudgetMode;
  remark: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationSubjectData {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  description: string | null;
  level: number;
  isLeaf: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface MigrationAnnualBudgetData extends MoneyTriple {
  id: string;
  year: number;
}

export interface MigrationSubjectBudgetData extends MoneyTriple {
  id: string;
  year: number;
  subjectId: string;
  unit: string | null;
  quantity: string | null;
  unitPrice: string | null;
}

export interface MigrationSubjectTotalBudgetData extends MoneyTriple {
  id: string;
  subjectId: string;
}

export interface MigrationInitialApplicationData {
  id: string;
  status: ApprovalStatus;
  applicantId: string;
  submittedAt: string | null;
  approverId: string | null;
  approvedAt: string | null;
  opinion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationAdjustmentLineData {
  id: string;
  year: number;
  subjectId: string | null;
  totalAdjustment: string;
  annualAdjustment: string;
  newSubjectName: string | null;
  newSubjectParentId: string | null;
}

export interface MigrationAdjustmentData {
  id: string;
  year: number;
  kind: 'ADJUST' | 'ALLOCATE';
  expandTotals: boolean;
  totalReason: string | null;
  annualReason: string | null;
  status: ApprovalStatus;
  applicantId: string;
  approverId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  submittedAt: string | null;
  lines: MigrationAdjustmentLineData[];
}

export interface MigrationSubjectChangeData {
  id: string;
  status: ApprovalStatus;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  applicantId: string;
  approverId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationUserRefNote {
  role: string;
  userId: string;
  userName: string;
}

export interface MigrationProvenance {
  sourceOwner: MigrationUserRefNote | null;
  userRefs: MigrationUserRefNote[];
  pending: {
    initialApplication: boolean;
    adjustments: { id: string; year: number }[];
    subjectChanges: string[];
  };
}

export interface MigrationPackage {
  formatVersion: number;
  kind: typeof MIGRATION_PACKAGE_KIND;
  appVersion: string;
  migrationHead: string;
  exportedAt: string;
  project: MigrationProjectData;
  subjects: MigrationSubjectData[];
  projectBudget: (MoneyTriple & { projectId: string }) | null;
  annualBudgets: MigrationAnnualBudgetData[];
  subjectBudgets: MigrationSubjectBudgetData[];
  subjectTotalBudgets: MigrationSubjectTotalBudgetData[];
  initialApplication: MigrationInitialApplicationData | null;
  adjustments: MigrationAdjustmentData[];
  subjectChanges: MigrationSubjectChangeData[];
  provenance: MigrationProvenance;
}

// ---------- 序列化助手 ----------

const dec = (v: Prisma.Decimal) => v.toFixed(2);
const decOrNull = (v: Prisma.Decimal | null) => (v === null ? null : v.toFixed(2));
const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());
const dt = (s: string | null) => (s === null ? null : new Date(s));

// ---------- 导出 ----------

export interface ExportPackageOptions {
  /** 存在 PENDING 单时仍导出(默认拒绝)。 */
  force?: boolean;
}

/** 按编号精确匹配或名称包含匹配解析项目;0/多命中均报错(同 export-project-budget 惯例)。 */
export async function resolveProjectRef(projectRef: string) {
  const matches = await prisma.project.findMany({
    where: { OR: [{ code: projectRef }, { name: { contains: projectRef } }] },
    include: { owner: true },
    orderBy: { code: 'asc' },
  });
  if (matches.length === 0) {
    throw new MigrationError(`未找到项目: ${projectRef}`);
  }
  if (matches.length > 1) {
    throw new MigrationError(
      `匹配到 ${matches.length} 个项目,请用项目编号精确指定:`,
      matches.map((p) => `${p.code} ${p.name}`),
    );
  }
  return matches[0];
}

export async function exportPackage(
  projectRef: string,
  opts: ExportPackageOptions = {},
): Promise<MigrationPackage> {
  const project = await resolveProjectRef(projectRef);
  const projectId = project.id;

  const [
    subjects,
    projectBudget,
    annualBudgets,
    subjectBudgets,
    subjectTotalBudgets,
    initialApplication,
    adjustments,
    subjectChanges,
  ] = await Promise.all([
    prisma.budgetSubject.findMany({
      where: { projectId },
      orderBy: [{ level: 'asc' }, { code: 'asc' }],
    }),
    prisma.projectBudget.findUnique({ where: { projectId } }),
    prisma.annualBudget.findMany({ where: { projectId }, orderBy: { year: 'asc' } }),
    prisma.subjectBudget.findMany({
      where: { projectId },
      orderBy: [{ year: 'asc' }, { subjectId: 'asc' }],
    }),
    prisma.subjectTotalBudget.findMany({ where: { projectId }, orderBy: { subjectId: 'asc' } }),
    prisma.initialBudgetApplication.findUnique({ where: { projectId } }),
    prisma.budgetAdjustment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    prisma.subjectChangeApplication.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const adjustmentLines = adjustments.length
    ? await prisma.budgetAdjustmentLine.findMany({
        where: { adjustmentId: { in: adjustments.map((a) => a.id) } },
        orderBy: { id: 'asc' },
      })
    : [];

  // 导出守卫:PENDING(已提交待审批)单默认拒绝——目标环境没人「应该」批它。
  const pendingAdjustments = adjustments.filter((a) => a.status === 'PENDING');
  const pendingSubjectChanges = subjectChanges.filter((s) => s.status === 'PENDING');
  const pendingInitial = initialApplication?.status === 'PENDING';
  if (
    (pendingInitial || pendingAdjustments.length > 0 || pendingSubjectChanges.length > 0) &&
    !opts.force
  ) {
    throw new MigrationError(
      '项目存在 PENDING(待审批)单据,默认拒绝导出。确认带着在途单迁移请加 --force:',
      [
        pendingInitial ? `初始编制单(id=${initialApplication!.id})待审批` : null,
        ...pendingAdjustments.map((a) => `调整单 ${a.year} 年(id=${a.id},kind=${a.kind})待审批`),
        ...pendingSubjectChanges.map((s) => `科目变更单(id=${s.id})待审批`),
      ].filter((x): x is string => x !== null),
    );
  }

  // 来源附注:收集全部 User 引用并补名字快照(导入时若重映射/置空,原名只在此可查)。
  const refMap = new Map<string, MigrationUserRefNote>();
  const addRef = (role: string, userId: string | null) => {
    if (!userId || refMap.has(userId)) return;
    refMap.set(userId, { role, userId, userName: '' });
  };
  addRef('project.owner', project.ownerId);
  addRef('initialApplication.applicant', initialApplication?.applicantId ?? null);
  addRef('initialApplication.approver', initialApplication?.approverId ?? null);
  for (const a of adjustments) {
    addRef('adjustment.applicant', a.applicantId);
    addRef('adjustment.approver', a.approverId);
  }
  for (const s of subjectChanges) {
    addRef('subjectChange.applicant', s.applicantId);
    addRef('subjectChange.approver', s.approverId);
  }
  const users = refMap.size
    ? await prisma.user.findMany({
        where: { id: { in: [...refMap.keys()] } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const userRefs = [...refMap.values()].map((r) => ({
    ...r,
    userName: nameById.get(r.userId) ?? '(源库已无此用户)',
  }));

  const [appVersion, migrationHead] = await Promise.all([getAppVersion(), getMigrationHead()]);

  return {
    formatVersion: MIGRATION_PACKAGE_FORMAT_VERSION,
    kind: MIGRATION_PACKAGE_KIND,
    appVersion,
    migrationHead,
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      level: project.level,
      projectType: project.projectType,
      undertakingUnit: project.undertakingUnit,
      startDate: isoOrNull(project.startDate),
      endDate: isoOrNull(project.endDate),
      ownerId: project.ownerId,
      budgetMode: project.budgetMode,
      remark: project.remark,
      archivedAt: isoOrNull(project.archivedAt),
      createdAt: iso(project.createdAt),
      updatedAt: iso(project.updatedAt),
    },
    subjects: subjects.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      code: s.code,
      name: s.name,
      description: s.description,
      level: s.level,
      isLeaf: s.isLeaf,
      sortOrder: s.sortOrder,
      createdAt: iso(s.createdAt),
    })),
    projectBudget: projectBudget
      ? {
          projectId,
          initialAmount: dec(projectBudget.initialAmount),
          adjustmentAmount: dec(projectBudget.adjustmentAmount),
          currentAmount: dec(projectBudget.currentAmount),
        }
      : null,
    annualBudgets: annualBudgets.map((a) => ({
      id: a.id,
      year: a.year,
      initialAmount: dec(a.initialAmount),
      adjustmentAmount: dec(a.adjustmentAmount),
      currentAmount: dec(a.currentAmount),
    })),
    subjectBudgets: subjectBudgets.map((s) => ({
      id: s.id,
      year: s.year,
      subjectId: s.subjectId,
      initialAmount: dec(s.initialAmount),
      adjustmentAmount: dec(s.adjustmentAmount),
      currentAmount: dec(s.currentAmount),
      unit: s.unit,
      quantity: decOrNull(s.quantity),
      unitPrice: decOrNull(s.unitPrice),
    })),
    subjectTotalBudgets: subjectTotalBudgets.map((s) => ({
      id: s.id,
      subjectId: s.subjectId,
      initialAmount: dec(s.initialAmount),
      adjustmentAmount: dec(s.adjustmentAmount),
      currentAmount: dec(s.currentAmount),
    })),
    initialApplication: initialApplication
      ? {
          id: initialApplication.id,
          status: initialApplication.status,
          applicantId: initialApplication.applicantId,
          submittedAt: isoOrNull(initialApplication.submittedAt),
          approverId: initialApplication.approverId,
          approvedAt: isoOrNull(initialApplication.approvedAt),
          opinion: initialApplication.opinion,
          createdAt: iso(initialApplication.createdAt),
          updatedAt: iso(initialApplication.updatedAt),
        }
      : null,
    adjustments: adjustments.map((a) => ({
      id: a.id,
      year: a.year,
      kind: a.kind,
      expandTotals: a.expandTotals,
      totalReason: a.totalReason,
      annualReason: a.annualReason,
      status: a.status,
      applicantId: a.applicantId,
      approverId: a.approverId,
      createdAt: iso(a.createdAt),
      updatedAt: iso(a.updatedAt),
      approvedAt: isoOrNull(a.approvedAt),
      submittedAt: isoOrNull(a.submittedAt),
      lines: adjustmentLines
        .filter((l) => l.adjustmentId === a.id)
        .map((l) => ({
          id: l.id,
          year: l.year,
          subjectId: l.subjectId,
          totalAdjustment: dec(l.totalAdjustment),
          annualAdjustment: dec(l.annualAdjustment),
          newSubjectName: l.newSubjectName,
          newSubjectParentId: l.newSubjectParentId,
        })),
    })),
    subjectChanges: subjectChanges.map((s) => ({
      id: s.id,
      status: s.status,
      beforeSnapshot: s.beforeSnapshot,
      afterSnapshot: s.afterSnapshot,
      applicantId: s.applicantId,
      approverId: s.approverId,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
    })),
    provenance: {
      sourceOwner: { role: 'project.owner', userId: project.ownerId, userName: project.owner.name },
      userRefs,
      pending: {
        initialApplication: pendingInitial,
        adjustments: pendingAdjustments.map((a) => ({ id: a.id, year: a.year })),
        subjectChanges: pendingSubjectChanges.map((s) => s.id),
      },
    },
  };
}

// ---------- 包校验 ----------

const APPROVAL_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

function assertApprovalStatus(v: string, where: string): void {
  if (!(APPROVAL_STATUSES as readonly string[]).includes(v)) {
    throw new MigrationError(`包内 ${where} 的 status 非法: ${v}`);
  }
}

/** 包完整性校验:envelope、枚举、包内引用闭合、唯一键。入事务前的干净失败。 */
export function validatePackage(pkg: MigrationPackage): void {
  if (!pkg || typeof pkg !== 'object') throw new MigrationError('包不是合法的 JSON 对象');
  if (pkg.kind !== MIGRATION_PACKAGE_KIND) {
    throw new MigrationError(`kind 不符: 期望 ${MIGRATION_PACKAGE_KIND},实际 ${String(pkg.kind)}`);
  }
  if (pkg.formatVersion !== MIGRATION_PACKAGE_FORMAT_VERSION) {
    throw new MigrationError(
      `包格式版本 ${String(pkg.formatVersion)} 不受支持(当前支持 ${MIGRATION_PACKAGE_FORMAT_VERSION})`,
    );
  }
  const p = pkg.project;
  if (!p?.id || !p?.code || !p?.name) throw new MigrationError('包缺 project.id / code / name');
  if (p.budgetMode !== 'GENERAL' && p.budgetMode !== 'LUMP_SUM') {
    throw new MigrationError(`project.budgetMode 非法: ${String(p.budgetMode)}`);
  }

  const subjectIds = new Set(pkg.subjects.map((s) => s.id));
  const details: string[] = [];
  for (const s of pkg.subjects) {
    if (s.parentId && !subjectIds.has(s.parentId))
      details.push(`科目 ${s.code} 的 parentId 不在包内`);
    if (s.parentId && pkg.subjects.find((x) => x.id === s.parentId)!.level >= s.level) {
      details.push(`科目 ${s.code} 的父节点 level 不小于自身(树损坏)`);
    }
  }
  const seenSubjectCodes = new Set<string>();
  for (const s of pkg.subjects) {
    const key = s.code;
    if (seenSubjectCodes.has(key)) details.push(`科目编码重复: ${key}`);
    seenSubjectCodes.add(key);
  }
  const seenSb = new Set<string>();
  for (const sb of pkg.subjectBudgets) {
    if (!subjectIds.has(sb.subjectId)) details.push(`科目×年度预算 ${sb.id} 引用了包外科目`);
    const key = `${sb.year}:${sb.subjectId}`;
    if (seenSb.has(key)) details.push(`科目×年度预算重复 (year=${sb.year})`);
    seenSb.add(key);
  }
  const seenStb = new Set<string>();
  for (const st of pkg.subjectTotalBudgets) {
    if (!subjectIds.has(st.subjectId)) details.push(`科目总预算 ${st.id} 引用了包外科目`);
    if (seenStb.has(st.subjectId)) details.push(`科目总预算重复 subjectId=${st.subjectId}`);
    seenStb.add(st.subjectId);
  }
  const seenYear = new Set<number>();
  for (const a of pkg.annualBudgets) {
    if (seenYear.has(a.year)) details.push(`年度预算重复: ${a.year}`);
    seenYear.add(a.year);
  }
  for (const a of pkg.adjustments) {
    if (a.kind !== 'ADJUST' && a.kind !== 'ALLOCATE')
      details.push(`调整单 ${a.id} kind 非法: ${a.kind}`);
    assertApprovalStatus(a.status, `调整单 ${a.id}`);
    for (const l of a.lines) {
      if (l.subjectId && !subjectIds.has(l.subjectId)) {
        details.push(`调整单 ${a.id} 明细 ${l.id} 引用了包外科目`);
      }
      if (l.newSubjectParentId && !subjectIds.has(l.newSubjectParentId)) {
        details.push(`调整单 ${a.id} 明细 ${l.id} 的 newSubjectParentId 不在包内`);
      }
    }
  }
  if (pkg.initialApplication) assertApprovalStatus(pkg.initialApplication.status, '初始编制单');
  for (const s of pkg.subjectChanges) assertApprovalStatus(s.status, `科目变更单 ${s.id}`);
  if (details.length > 0) {
    throw new MigrationError('包完整性校验失败:', details.slice(0, 20));
  }
}

/** 读取并校验包文件(import-package CLI 入口)。 */
export async function readPackageFile(file: string): Promise<MigrationPackage> {
  let pkg: MigrationPackage;
  try {
    pkg = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new MigrationError(
      `包文件读取/解析失败: ${file}(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  validatePackage(pkg);
  return pkg;
}

// ---------- 导入 ----------

export interface ImportPackageOptions {
  /** 同编号冲突时整体替换(仅限目标项目骨架态)。 */
  overwrite?: boolean;
  /** 按姓名或 SSO sub(UUID)认领 OWNER;缺省以最早 ADMIN 占位负责人并警告。 */
  ownerKey?: string;
  /** 版本偏差放行。 */
  allowSkew?: boolean;
}

export interface UserRefAction {
  field: string;
  originalUserId: string;
  originalUserName: string | null;
  action: 'kept' | 'remapped' | 'nullified';
}

export interface ImportReport {
  projectCode: string;
  projectName: string;
  replacedExisting: boolean;
  owner: { mode: 'claimed' | 'placeholder'; userId: string; userName: string };
  userRefActions: UserRefAction[];
  inserted: {
    subjects: number;
    annualBudgets: number;
    subjectBudgets: number;
    subjectTotalBudgets: number;
    adjustments: number;
    adjustmentLines: number;
    subjectChanges: number;
  };
  summaryCheck: SummaryVerifyResult;
  warnings: string[];
}

/**
 * 按依赖序删除一个项目的全部数据(骨架+业务记录+成员;导入 --overwrite 与测试清理共用)。
 * 审计行由库级 SetNull 解绑、ApprovalLog 的 objectId 引用悬空保留——均在调用方提示。
 */
export async function deleteProjectCascade(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  await tx.businessRecord.deleteMany({ where: { projectId } });
  await tx.budgetLock.deleteMany({ where: { projectId } });
  await tx.subjectChangeApplication.deleteMany({ where: { projectId } });
  await tx.budgetAdjustmentLine.deleteMany({ where: { adjustment: { projectId } } });
  await tx.budgetAdjustment.deleteMany({ where: { projectId } });
  await tx.initialBudgetApplication.deleteMany({ where: { projectId } });
  await tx.subjectTotalBudget.deleteMany({ where: { projectId } });
  await tx.subjectBudget.deleteMany({ where: { projectId } });
  await tx.annualBudget.deleteMany({ where: { projectId } });
  await tx.projectBudget.deleteMany({ where: { projectId } });
  await tx.projectMember.deleteMany({ where: { projectId } });
  await tx.budgetSubject.deleteMany({ where: { projectId } });
  await tx.project.deleteMany({ where: { id: projectId } });
}

/** make-admin 同款严格查找:UUID→id/authSubject/name,非 UUID→name;多命中列候选拒绝。 */
async function resolveActingUser(ownerKey?: string) {
  if (ownerKey) {
    const users = await findUsersByKey(prisma, ownerKey);
    if (users.length === 0) {
      throw new MigrationError(
        `--owner 未找到用户: ${ownerKey}(可传姓名、用户 id 或 SSO sub UUID)`,
      );
    }
    if (users.length > 1) {
      throw new MigrationError(
        `--owner 匹配到 ${users.length} 个用户,拒绝歧义认领。请改用用户 id 或 SSO sub 精确指定:`,
        users.map((u) => `${u.name} (${u.id}) 角色=${u.role} 状态=${u.status}`),
      );
    }
    const user = users[0];
    if (user.status !== 'active') {
      throw new MigrationError(`--owner 用户已停用: ${user.name} (${user.id})`);
    }
    return { user, mode: 'claimed' as const };
  }
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) {
    throw new MigrationError('目标环境没有 ADMIN 用户,无法占位负责人;请用 --owner 显式指定。');
  }
  return { user: admin, mode: 'placeholder' as const };
}

export async function importPackage(
  pkg: MigrationPackage,
  opts: ImportPackageOptions = {},
): Promise<ImportReport> {
  validatePackage(pkg);

  // 版本守卫:包的 app/迁移头与当前环境不一致默认拒绝。
  const [appVersion, migrationHead] = await Promise.all([getAppVersion(), getMigrationHead()]);
  if ((pkg.appVersion !== appVersion || pkg.migrationHead !== migrationHead) && !opts.allowSkew) {
    throw new MigrationError('包与目标环境版本不一致,默认拒绝导入:', [
      `包:   app ${pkg.appVersion} / 迁移头 ${pkg.migrationHead}(${pkg.exportedAt})`,
      `当前: app ${appVersion} / 迁移头 ${migrationHead}`,
      'schema 错位的半失败导入最难收拾;确认自担风险请加 --allow-skew。',
    ]);
  }

  // 先解析操作者:参数错(找不到/歧义/停用)应最先暴露,不与冲突检查纠缠。
  const acting = await resolveActingUser(opts.ownerKey);
  const warnings: string[] = [];
  if (acting.mode === 'placeholder') {
    warnings.push(
      `未指定 --owner:负责人(ownerId)已占位为最早的管理员 ${acting.user.name}(${acting.user.id}),` +
        '不代表成员关系;请在目标环境 UI「成员管理」认领真实负责人。',
    );
  }
  if (
    pkg.provenance?.pending &&
    (pkg.provenance.pending.initialApplication ||
      pkg.provenance.pending.adjustments.length > 0 ||
      pkg.provenance.pending.subjectChanges.length > 0)
  ) {
    warnings.push('包在源环境导出时存在 PENDING 单据(--force 带出),目标环境管理员可继续审批。');
  }

  // 冲突守卫:同编号默认拒绝;--overwrite 仅限骨架态(无业务记录/到账/导入批次),否则硬拒绝。
  const existing = await prisma.project.findUnique({ where: { code: pkg.project.code } });
  if (existing && !opts.overwrite) {
    throw new MigrationError(
      `项目编号 ${pkg.project.code} 已存在于目标环境,默认拒绝。整体替换请加 --overwrite:`,
      [
        `既有: ${existing.code} ${existing.name}(id=${existing.id},归档=${existing.archivedAt ? '是' : '否'})`,
      ],
    );
  }
  if (existing && opts.overwrite) {
    const [records, receipts, batches, members] = await Promise.all([
      prisma.businessRecord.count({ where: { projectId: existing.id } }),
      prisma.receiptRecord.count({ where: { projectId: existing.id } }),
      prisma.importBatch.count({ where: { projectId: existing.id } }),
      prisma.projectMember.count({ where: { projectId: existing.id } }),
    ]);
    if (records + receipts + batches > 0) {
      throw new MigrationError(
        `目标项目 ${pkg.project.code} 已产生业务数据(业务记录 ${records} / 到账 ${receipts} / 导入批次 ${batches}),` +
          '--overwrite 仅限骨架态项目。迁移包不带台账,因此无权销毁目标侧台账;此拒绝没有任何绕过通道。',
      );
    }
    // 替换的边界透明化:成员随之移除、审计/审批痕迹不迁移,都让操作者看见。
    warnings.push(
      `--overwrite 将整体替换既有项目:目标侧成员关系 ${members} 条一并移除(包不含成员,导入后需重新认领);` +
        '既有审批/审计痕迹不迁移(审计行解绑、审批日志引用悬空保留)。',
    );
  }

  // User 引用重映射:同 ID 保留;必填→acting 用户;可空→置空。原名字从来源附注回查。
  const nameBySourceId = new Map<string, string>(
    (pkg.provenance?.userRefs ?? []).map((r) => [r.userId, r.userName]),
  );
  const pkgUserIds = new Set<string>([pkg.project.ownerId]);
  if (pkg.initialApplication) {
    pkgUserIds.add(pkg.initialApplication.applicantId);
    if (pkg.initialApplication.approverId) pkgUserIds.add(pkg.initialApplication.approverId);
  }
  for (const a of pkg.adjustments) {
    pkgUserIds.add(a.applicantId);
    if (a.approverId) pkgUserIds.add(a.approverId);
  }
  for (const s of pkg.subjectChanges) {
    pkgUserIds.add(s.applicantId);
    if (s.approverId) pkgUserIds.add(s.approverId);
  }
  const existingUserIds = new Set(
    pkgUserIds.size
      ? (
          await prisma.user.findMany({
            where: { id: { in: [...pkgUserIds] } },
            select: { id: true },
          })
        ).map((u) => u.id)
      : [],
  );
  const userRefActions: UserRefAction[] = [];
  const remap = (userId: string | null, field: string, required: boolean): string | null => {
    if (userId === null) return null;
    if (existingUserIds.has(userId)) {
      userRefActions.push({
        field,
        originalUserId: userId,
        originalUserName: nameBySourceId.get(userId) ?? null,
        action: 'kept',
      });
      return userId;
    }
    if (!required) {
      // 可空引用(approverId)置空:审批人在目标环境不存在,保留只会留下悬空/错位的痕迹。
      userRefActions.push({
        field,
        originalUserId: userId,
        originalUserName: nameBySourceId.get(userId) ?? null,
        action: 'nullified',
      });
      return null;
    }
    // 必填引用(applicantId / ownerId)重映射到导入操作者。
    userRefActions.push({
      field,
      originalUserId: userId,
      originalUserName: nameBySourceId.get(userId) ?? null,
      action: 'remapped',
    });
    return acting.user.id;
  };

  const pid = pkg.project.id;
  const inserted = {
    subjects: 0,
    annualBudgets: 0,
    subjectBudgets: 0,
    subjectTotalBudgets: 0,
    adjustments: 0,
    adjustmentLines: 0,
    subjectChanges: 0,
  };

  await prisma.$transaction(async (tx) => {
    if (existing) {
      // 骨架态已验证:按依赖序整体移除目标侧同编号项目(成员一并,已在 warnings 提示)。
      await deleteProjectCascade(tx, existing.id);
    }

    const p = pkg.project;
    await tx.project.create({
      data: {
        id: pid,
        code: p.code,
        name: p.name,
        level: p.level,
        projectType: p.projectType,
        undertakingUnit: p.undertakingUnit,
        startDate: dt(p.startDate),
        endDate: dt(p.endDate),
        ownerId: remap(p.ownerId, 'project.ownerId', true)!,
        budgetMode: p.budgetMode,
        remark: p.remark,
        archivedAt: dt(p.archivedAt),
        createdAt: dt(p.createdAt)!,
        updatedAt: dt(p.updatedAt)!,
      },
    });

    // 科目树按 level 升序插入,保证自引用 FK 的父行先在。
    const subjects = [...pkg.subjects].sort(
      (a, b) => a.level - b.level || a.code.localeCompare(b.code),
    );
    for (const s of subjects) {
      await tx.budgetSubject.create({
        data: {
          id: s.id,
          projectId: pid,
          parentId: s.parentId,
          code: s.code,
          name: s.name,
          description: s.description,
          level: s.level,
          isLeaf: s.isLeaf,
          sortOrder: s.sortOrder,
          createdAt: dt(s.createdAt)!,
        },
      });
      inserted.subjects++;
    }

    if (pkg.projectBudget) {
      await tx.projectBudget.create({
        data: {
          projectId: pid,
          initialAmount: pkg.projectBudget.initialAmount,
          adjustmentAmount: pkg.projectBudget.adjustmentAmount,
          currentAmount: pkg.projectBudget.currentAmount,
        },
      });
    }
    for (const a of pkg.annualBudgets) {
      await tx.annualBudget.create({
        data: {
          id: a.id,
          projectId: pid,
          year: a.year,
          initialAmount: a.initialAmount,
          adjustmentAmount: a.adjustmentAmount,
          currentAmount: a.currentAmount,
        },
      });
      inserted.annualBudgets++;
    }
    for (const s of pkg.subjectBudgets) {
      await tx.subjectBudget.create({
        data: {
          id: s.id,
          projectId: pid,
          year: s.year,
          subjectId: s.subjectId,
          initialAmount: s.initialAmount,
          adjustmentAmount: s.adjustmentAmount,
          currentAmount: s.currentAmount,
          unit: s.unit,
          quantity: s.quantity,
          unitPrice: s.unitPrice,
        },
      });
      inserted.subjectBudgets++;
    }
    for (const s of pkg.subjectTotalBudgets) {
      await tx.subjectTotalBudget.create({
        data: {
          id: s.id,
          projectId: pid,
          subjectId: s.subjectId,
          initialAmount: s.initialAmount,
          adjustmentAmount: s.adjustmentAmount,
          currentAmount: s.currentAmount,
        },
      });
      inserted.subjectTotalBudgets++;
    }

    if (pkg.initialApplication) {
      const ia = pkg.initialApplication;
      await tx.initialBudgetApplication.create({
        data: {
          id: ia.id,
          projectId: pid,
          status: ia.status,
          applicantId: remap(ia.applicantId, 'initialApplication.applicantId', true)!,
          submittedAt: dt(ia.submittedAt),
          approverId: remap(ia.approverId, 'initialApplication.approverId', false),
          approvedAt: dt(ia.approvedAt),
          opinion: ia.opinion,
          createdAt: dt(ia.createdAt)!,
          updatedAt: dt(ia.updatedAt)!,
        },
      });
    }
    for (const a of pkg.adjustments) {
      await tx.budgetAdjustment.create({
        data: {
          id: a.id,
          projectId: pid,
          year: a.year,
          kind: a.kind,
          expandTotals: a.expandTotals,
          totalReason: a.totalReason,
          annualReason: a.annualReason,
          status: a.status,
          applicantId: remap(a.applicantId, 'adjustment.applicantId', true)!,
          approverId: remap(a.approverId, 'adjustment.approverId', false),
          createdAt: dt(a.createdAt)!,
          updatedAt: dt(a.updatedAt)!,
          approvedAt: dt(a.approvedAt),
          submittedAt: dt(a.submittedAt),
        },
      });
      inserted.adjustments++;
      for (const l of a.lines) {
        await tx.budgetAdjustmentLine.create({
          data: {
            id: l.id,
            adjustmentId: a.id,
            year: l.year,
            subjectId: l.subjectId,
            totalAdjustment: l.totalAdjustment,
            annualAdjustment: l.annualAdjustment,
            newSubjectName: l.newSubjectName,
            newSubjectParentId: l.newSubjectParentId,
          },
        });
        inserted.adjustmentLines++;
      }
    }
    for (const s of pkg.subjectChanges) {
      await tx.subjectChangeApplication.create({
        data: {
          id: s.id,
          projectId: pid,
          status: s.status,
          beforeSnapshot: s.beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: s.afterSnapshot as Prisma.InputJsonValue,
          applicantId: remap(s.applicantId, 'subjectChange.applicantId', true)!,
          approverId: remap(s.approverId, 'subjectChange.approverId', false),
          createdAt: dt(s.createdAt)!,
          updatedAt: dt(s.updatedAt)!,
        },
      });
      inserted.subjectChanges++;
    }

    if (acting.mode === 'claimed') {
      await tx.projectMember.create({
        data: { id: uuidv7(), projectId: pid, userId: acting.user.id, memberRole: 'OWNER' },
      });
    }
  }, BULK_TX_OPTIONS);

  const summaryCheck = await verifyAndFixProjectSummaries(pid, { apply: true });

  return {
    projectCode: pkg.project.code,
    projectName: pkg.project.name,
    replacedExisting: !!existing,
    owner: { mode: acting.mode, userId: acting.user.id, userName: acting.user.name },
    userRefActions,
    inserted,
    summaryCheck,
    warnings,
  };
}
