import { ApprovalStatus, Prisma, SubjectChangeApplication, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';

/**
 * §5.3 科目变更单:在不破坏既有预算/业务数据的前提下对科目树做结构性变更
 * (rename / recode / redesc / add / remove / move)。审批生效时把 after 快照
 * 应用到 BudgetSubject。
 *
 * §5.4 结构保护:已存在 subject_budgets 或 business_records 的科目不得
 * remove/move(改父)/改 isLeaf;只允许 rename/recode/redesc。
 */

/** §5.3 支持的科目变更操作类型。 */
export type SubjectChangeOpType = 'rename' | 'recode' | 'redesc' | 'add' | 'remove' | 'move';

const OP_TYPES: ReadonlySet<SubjectChangeOpType> = new Set<SubjectChangeOpType>([
  'rename',
  'recode',
  'redesc',
  'add',
  'remove',
  'move',
]);

/** §5.3 单条结构变更操作(payload)。 */
export interface SubjectChangeOperation {
  type: SubjectChangeOpType;
  /** 目标科目编码(recode 后的旧编码;add 时为 null)。 */
  subjectCode?: string | null;
  /** recode 后的新编码;add 时为新科目编码。 */
  newCode?: string | null;
  /** rename 后的新名称;add 时为新科目名称。 */
  newName?: string | null;
  /** redesc / add 后的新说明。 */
  newDescription?: string | null;
  /** move / add 后的父编码(null = 顶级)。 */
  newParentCode?: string | null;
  /** add 时的 isLeaf 标记。 */
  isLeaf?: boolean | null;
}

/** §5.3 科目变更单 payload(来自表单)。 */
export interface SubjectChangePayload {
  operations: SubjectChangeOperation[];
}

/** 科目树快照中的单个节点(Decimal-free,可安全存 JSONB)。 */
export interface SubjectSnapshotNode {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  parentCode: string | null;
  level: number;
  isLeaf: boolean;
}

/** 把单个变更单序列化为审计快照对象。 */
function snapshotApplication(row: SubjectChangeApplication): Record<string, unknown> {
  return snapshotRow({
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    applicantId: row.applicantId,
    approverId: row.approverId,
  });
}

/**
 * 把项目当前科目树拉取并序列化为 Decimal-free 快照数组。
 * 快照里同时保留 id 与 code(以及 parentCode),便于审批时按 id 落地变更。
 */
export async function buildSubjectSnapshot(
  projectId: string,
  tx?: Prisma.TransactionClient | typeof prisma,
): Promise<SubjectSnapshotNode[]> {
  const client = tx ?? prisma;
  const subjects = await client.budgetSubject.findMany({
    where: { projectId },
    orderBy: { code: 'asc' },
  });
  const byId = new Map(subjects.map((s) => [s.id, s]));
  return subjects.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    description: s.description,
    parentId: s.parentId,
    parentCode: s.parentId ? (byId.get(s.parentId)?.code ?? null) : null,
    level: s.level,
    isLeaf: s.isLeaf,
  }));
}

/**
 * §5.4 判断某科目是否"已被使用"(有预算或非作废业务记录)。
 * 已使用的科目受结构保护:不得删除/移动/改叶属性。
 */
async function isSubjectUsed(tx: Prisma.TransactionClient, subjectId: string): Promise<boolean> {
  const [budgetCount, recordCount] = await Promise.all([
    tx.subjectBudget.count({ where: { subjectId } }),
    tx.businessRecord.count({ where: { subjectId, isVoid: false } }),
  ]);
  return budgetCount > 0 || recordCount > 0;
}

/**
 * §5.4 结构保护校验:遍历 operations,对每个受保护操作(remove/move/改 isLeaf)
 * 校验目标科目是否未被使用;若已使用则抛 422。
 *
 * rename/recode/redesc 不受限制(即使科目已使用也允许)。
 * 该函数在事务内执行(需要 tx 查 subject_budgets/business_records)。
 *
 * 注:本函数只校验"是否允许执行",不修改快照;实际快照投影在 projectOperations 中进行。
 */
async function assertStructureProtection(
  tx: Prisma.TransactionClient,
  projectId: string,
  operations: SubjectChangeOperation[],
  beforeSnapshot: SubjectSnapshotNode[],
): Promise<void> {
  const byCode = new Map(beforeSnapshot.map((s) => [s.code, s]));

  for (const op of operations) {
    if (op.type === 'rename' || op.type === 'recode' || op.type === 'redesc') {
      // 改名/改编码/改说明不受结构保护限制,即使已使用也允许。
      continue;
    }
    if (op.type === 'add') {
      // 新增无前置科目,不需要结构保护。
      continue;
    }
    // remove / move:必须针对 beforeSnapshot 中存在且未使用的科目。
    const code = op.subjectCode ?? undefined;
    if (!code) {
      throw new HTTPError(422, `${op.type} 操作缺少 subjectCode`);
    }
    const target = byCode.get(code);
    if (!target) {
      throw new HTTPError(422, `科目 ${code} 不存在,无法 ${op.type}`);
    }
    if (op.type === 'remove' || op.type === 'move') {
      const used = await isSubjectUsed(tx, target.id);
      if (used) {
        throw new HTTPError(422, `科目 ${code} 已关联数据,不得删除/移动/改叶节点属性`);
      }
    }
    if (op.type === 'move') {
      // 已通过 isSubjectUsed 校验;父编码合法性在 projectOperations 中再校验。
    }
  }
}

/**
 * 把一组 operations 应用到 beforeSnapshot 上,生成 afterSnapshot(纯函数投影)。
 * 校验同时进行:新增编码不重复、recode 不与现存科目冲突、move 父编码存在、
 * 不形成自环等。任一校验失败 → 422。
 *
 * 返回 afterSnapshot(数组,结构与 before 一致)。
 */
export function projectOperations(
  before: SubjectSnapshotNode[],
  operations: SubjectChangeOperation[],
): SubjectSnapshotNode[] {
  // 工作副本(深拷贝)。
  const nodes = before.map((n) => ({ ...n }));
  const byCode = new Map(nodes.map((n) => [n.code, n]));

  const maxLevel = (parentCode: string | null | undefined): number => {
    if (!parentCode) return 1; // 顶级 = 1
    const parent = byCode.get(parentCode);
    if (!parent) {
      throw new HTTPError(422, `父科目 ${parentCode} 不存在`);
    }
    return parent.level + 1;
  };

  for (const [index, op] of operations.entries()) {
    const ctx = `第 ${index + 1} 条操作`;
    if (!OP_TYPES.has(op.type)) {
      throw new HTTPError(422, `${ctx} type 非法:${op.type}`);
    }

    if (op.type === 'add') {
      const code = op.newCode?.trim();
      if (!code) {
        throw new HTTPError(422, `${ctx}(add) 缺少 newCode`);
      }
      if (byCode.has(code)) {
        throw new HTTPError(422, `${ctx}(add) 科目编码 ${code} 已存在`);
      }
      const isLeaf = op.isLeaf ?? true;
      const parentCode = op.newParentCode ?? null;
      // 父必须存在(若指定)。
      if (parentCode && !byCode.has(parentCode)) {
        throw new HTTPError(422, `${ctx}(add) 父科目 ${parentCode} 不存在`);
      }
      // 不允许把新科目挂到某个叶子下(叶子不应再有子科目)。
      if (parentCode) {
        const parent = byCode.get(parentCode)!;
        if (parent.isLeaf) {
          throw new HTTPError(422, `${ctx}(add) 父科目 ${parentCode} 是叶节点,不能挂子科目`);
        }
      }
      const name = op.newName?.trim();
      if (!name) {
        throw new HTTPError(422, `${ctx}(add) 缺少 newName`);
      }
      const newNode: SubjectSnapshotNode = {
        // id 在审批生效时由 uuidv7 生成;快照里用占位符,落地时忽略。
        id: `new:${code}`,
        code,
        name,
        description: op.newDescription ?? null,
        parentId: parentCode ? byCode.get(parentCode)!.id : null,
        parentCode,
        level: maxLevel(parentCode),
        isLeaf,
      };
      nodes.push(newNode);
      byCode.set(code, newNode);
      continue;
    }

    // rename/recode/redesc/remove/move 都需要 subjectCode 指向现存节点。
    const code = op.subjectCode?.trim();
    if (!code) {
      throw new HTTPError(422, `${ctx}(${op.type}) 缺少 subjectCode`);
    }
    const target = byCode.get(code);
    if (!target) {
      throw new HTTPError(422, `${ctx}(${op.type}) 目标科目 ${code} 不存在`);
    }

    if (op.type === 'rename') {
      const name = op.newName?.trim();
      if (!name) {
        throw new HTTPError(422, `${ctx}(rename) 缺少 newName`);
      }
      target.name = name;
      continue;
    }

    if (op.type === 'recode') {
      const newCode = op.newCode?.trim();
      if (!newCode) {
        throw new HTTPError(422, `${ctx}(recode) 缺少 newCode`);
      }
      if (newCode !== code) {
        if (byCode.has(newCode)) {
          throw new HTTPError(422, `${ctx}(recode) 新编码 ${newCode} 已存在`);
        }
        // 维护 byCode 索引。
        byCode.delete(code);
        target.code = newCode;
        byCode.set(newCode, target);
        // 子节点的 parentCode 若引用旧 code 也同步(子仍按 parentId 关联,code 仅用于展示)。
        for (const n of nodes) {
          if (n.parentCode === code) n.parentCode = newCode;
        }
      }
      continue;
    }

    if (op.type === 'redesc') {
      target.description = op.newDescription ?? null;
      continue;
    }

    if (op.type === 'remove') {
      // 删除自身 + 其下所有子孙(快照投影;结构保护已在 assertStructureProtection 校验)。
      const toRemove = new Set<string>([target.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes) {
          if (n.parentId && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
            toRemove.add(n.id);
            changed = true;
          }
        }
      }
      const removedCodes = new Set(nodes.filter((n) => toRemove.has(n.id)).map((n) => n.code));
      for (const c of removedCodes) byCode.delete(c);
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (toRemove.has(nodes[i].id)) nodes.splice(i, 1);
      }
      continue;
    }

    if (op.type === 'move') {
      const parentCode = op.newParentCode ?? null;
      if (parentCode === code) {
        throw new HTTPError(422, `${ctx}(move) 父编码不能指向自身`);
      }
      if (parentCode) {
        const parent = byCode.get(parentCode);
        if (!parent) {
          throw new HTTPError(422, `${ctx}(move) 父科目 ${parentCode} 不存在`);
        }
        if (parent.isLeaf) {
          throw new HTTPError(422, `${ctx}(move) 父科目 ${parentCode} 是叶节点,不能挂子科目`);
        }
        // 防止把祖先移到其后代下(形成环)。
        let cursor: SubjectSnapshotNode | undefined = parent;
        while (cursor) {
          if (cursor.id === target.id) {
            throw new HTTPError(
              422,
              `${ctx}(move) 不能把科目 ${code} 移到其后代 ${parentCode} 下(会形成环)`,
            );
          }
          cursor = cursor.parentId
            ? byCode.get(nodes.find((n) => n.id === cursor!.parentId)?.code ?? '')
            : undefined;
        }
      }
      target.parentCode = parentCode;
      target.parentId = parentCode ? byCode.get(parentCode)!.id : null;
      // level 重算(自身 + 所有后代)。
      const recomputeLevels = (root: SubjectSnapshotNode): void => {
        const parent = root.parentId ? nodes.find((n) => n.id === root.parentId) : undefined;
        root.level = parent ? parent.level + 1 : 1;
        for (const n of nodes) {
          if (n.parentId === root.id) recomputeLevels(n);
        }
      };
      recomputeLevels(target);
      continue;
    }
  }

  return nodes;
}

/**
 * §5.3 创建科目变更草稿(createSubjectChange)。
 *
 * - 权限:budget:changeSubject + 项目范围(§2.2)。
 * - 校验 operations 合法性(projectOperations 投影 + §5.4 结构保护)。
 * - beforeSnapshot = 当前科目树(Decimal-free);afterSnapshot = 投影后科目树。
 * - 落库 SubjectChangeApplication(status=DRAFT)+ 审计 create。
 */
export async function createSubjectChange(
  projectId: string,
  payload: SubjectChangePayload,
  user: Pick<User, 'id' | 'role'>,
): Promise<SubjectChangeApplication> {
  await requirePermission(user, 'budget:changeSubject', projectId);

  if (!payload || !Array.isArray(payload.operations) || payload.operations.length === 0) {
    throw new HTTPError(422, '变更操作不能为空');
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, archivedAt: true },
  });
  if (!project) {
    throw new HTTPError(404, '项目不存在');
  }
  if (project.archivedAt) {
    throw new HTTPError(409, '项目已归档,不可发起科目变更');
  }

  const beforeSnapshot = await buildSubjectSnapshot(projectId);
  // 先做纯函数投影(校验 add/recode/move 等结构合法性)。
  const afterSnapshot = projectOperations(beforeSnapshot, payload.operations);

  const id = uuidv7();

  return prisma.$transaction(async (tx) => {
    // §5.4 结构保护:remove/move 不得作用于已使用的科目。审批时也会复跑。
    await assertStructureProtection(tx, projectId, payload.operations, beforeSnapshot);

    const created = await tx.subjectChangeApplication.create({
      data: {
        id,
        projectId,
        status: ApprovalStatus.DRAFT,
        beforeSnapshot: beforeSnapshot as unknown as Prisma.InputJsonValue,
        afterSnapshot: afterSnapshot as unknown as Prisma.InputJsonValue,
        applicantId: user.id,
      },
    });

    await recordAudit(tx, {
      projectId,
      objectType: 'subject_change_applications',
      objectId: id,
      action: 'create',
      operatorId: user.id,
      after: snapshotApplication(created),
    });

    return created;
  });
}

/** 列出某项目的科目变更单(不含快照主体,仅元数据;前端按需取详情)。 */
export async function listSubjectChanges(
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<SubjectChangeApplication[]> {
  await requirePermission(user, 'project:view', projectId);
  return prisma.subjectChangeApplication.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
}

/** 取单个科目变更单(含快照)。 */
export async function getSubjectChange(
  appId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<SubjectChangeApplication> {
  const app = await prisma.subjectChangeApplication.findUnique({ where: { id: appId } });
  if (!app) {
    throw new HTTPError(404, '科目变更单不存在');
  }
  await requirePermission(user, 'project:view', app.projectId);
  return app;
}

/** §5.3 提交(DRAFT→PENDING)。 */
export async function submitSubjectChange(
  appId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<SubjectChangeApplication> {
  const app = await prisma.subjectChangeApplication.findUnique({ where: { id: appId } });
  if (!app) {
    throw new HTTPError(404, '科目变更单不存在');
  }
  await requirePermission(user, 'budget:changeSubject', app.projectId);

  if (app.status !== ApprovalStatus.DRAFT) {
    throw new HTTPError(409, `当前状态 ${app.status} 不可提交,仅 DRAFT 可提交`);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.subjectChangeApplication.update({
      where: { id: appId },
      data: { status: ApprovalStatus.PENDING },
    });
    await recordAudit(tx, {
      projectId: app.projectId,
      objectType: 'subject_change_applications',
      objectId: appId,
      action: 'submit',
      operatorId: user.id,
      before: snapshotApplication(app),
      after: snapshotApplication(updated),
    });
    return updated;
  });
}

/**
 * §5.4 把 afterSnapshot 应用到实际 BudgetSubject 行(事务内)。
 * - rename/recode/redesc:原地 update 已有行(按快照中的 id 定位)。
 * - add:id 以 "new:" 开头的节点 → 新建(uuidv7 生成 id)。
 * - remove:beforeSnapshot 中存在但 afterSnapshot 中不存在的 id → 删除。
 * - move:parentId 变化 → update parentId(同时也覆盖 level)。
 *
 * 注意:本函数只写 BudgetSubject;不触碰 subject_budgets / business_records
 * (受保护科目不会出现在 remove/move 操作中,关联数据保持原样)。
 */
async function applyAfterSnapshot(
  tx: Prisma.TransactionClient,
  projectId: string,
  before: SubjectSnapshotNode[],
  after: SubjectSnapshotNode[],
): Promise<void> {
  const beforeById = new Map(before.map((n) => [n.id, n]));
  const afterById = new Map(after.map((n) => [n.id, n]));

  // 1) 删除:before 中存在、after 中不存在的节点。
  const toDelete = [...beforeById.keys()].filter((id) => !afterById.has(id));
  if (toDelete.length > 0) {
    await tx.budgetSubject.deleteMany({
      where: { projectId, id: { in: toDelete } },
    });
  }

  // 用于解析 parentCode → 新建节点的 parentId(add 节点可能挂在另一个新节点下)。
  const codeToId = new Map<string, string>(
    after.filter((n) => !n.id.startsWith('new:')).map((n) => [n.code, n.id]),
  );

  // 2) 新增 + 3) 更新:按 after 顺序处理(add 先于挂在其下的 add)。
  // 用拓扑顺序保证父先于子:简单 BFS/迭代至稳定。
  // 由于 add 节点的 parentId 可能是另一个 add 节点的占位 id,需要先把 parentCode 解析。
  for (const node of after) {
    if (node.id.startsWith('new:')) {
      const code = node.id.slice('new:'.length);
      if (codeToId.has(code)) {
        // 同一 add 可能被前一轮处理过;跳过(理论上不会,因为每条 op 唯一)。
        continue;
      }
      // 解析 parentId(可能是另一个新节点的占位 id,也可能是已有 id)。
      let parentId: string | null = node.parentId;
      if (parentId && parentId.startsWith('new:')) {
        const parentCode = parentId.slice('new:'.length);
        parentId = codeToId.get(parentCode) ?? null;
      }
      const newId = uuidv7();
      await tx.budgetSubject.create({
        data: {
          id: newId,
          projectId,
          parentId,
          code: node.code,
          name: node.name,
          description: node.description,
          level: node.level,
          isLeaf: node.isLeaf,
        },
      });
      codeToId.set(code, newId);
    } else {
      // 已有节点:update code/name/description/parentId/level/isLeaf(若 move 改了 parent)。
      const before = beforeById.get(node.id);
      const parentId =
        node.parentId && node.parentId.startsWith('new:')
          ? (codeToId.get(node.parentId.slice('new:'.length)) ?? null)
          : node.parentId;
      // 只在确实变化时写(减少无意义 update;但 Prisma update 总是安全的)。
      if (
        !before ||
        before.code !== node.code ||
        before.name !== node.name ||
        before.description !== node.description ||
        before.parentId !== parentId ||
        before.level !== node.level
      ) {
        await tx.budgetSubject.update({
          where: { id: node.id },
          data: {
            code: node.code,
            name: node.name,
            description: node.description,
            parentId,
            level: node.level,
          },
        });
      }
    }
  }
}

/**
 * §5.3 审批生效(approveSubjectChange):PENDING → APPROVED,应用 afterSnapshot。
 *
 * - 权限:budget:approve。
 * - 复跑 §5.4 结构保护(提交后可能有新业务数据落到了受保护科目上 → 422)。
 * - 应用 afterSnapshot 到 BudgetSubject(原地 update / add / remove / move)。
 * - 审计 approve。
 */
export async function approveSubjectChange(
  appId: string,
  user: Pick<User, 'id' | 'role'>,
  opinion?: string,
): Promise<SubjectChangeApplication> {
  const app = await prisma.subjectChangeApplication.findUnique({ where: { id: appId } });
  if (!app) {
    throw new HTTPError(404, '科目变更单不存在');
  }
  await requirePermission(user, 'budget:approve', app.projectId);

  if (app.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${app.status} 不允许审批,仅 PENDING 可审批`);
  }

  const beforeSnapshot = app.beforeSnapshot as unknown as SubjectSnapshotNode[];
  const afterSnapshot = app.afterSnapshot as unknown as SubjectSnapshotNode[];

  // 从快照反推 operations 不现实;改为直接对 before/after 做 diff,校验"每个被删除/移动
  // 的科目仍未被使用"。
  return prisma.$transaction(async (tx) => {
    // §5.4 复跑结构保护:对 before 中存在、after 中消失或 parent/isLeaf 变化的科目,
    // 重新检查是否被使用。
    const beforeById = new Map(beforeSnapshot.map((n) => [n.id, n]));
    const afterById = new Map(afterSnapshot.map((n) => [n.id, n]));
    for (const [id, before] of beforeById.entries()) {
      const after = afterById.get(id);
      if (!after) {
        // 被删除。
        const used = await isSubjectUsed(tx, id);
        if (used) {
          throw new HTTPError(422, `科目 ${before.code} 已关联数据,不得删除/移动/改叶节点属性`);
        }
        continue;
      }
      if (after.parentId !== before.parentId) {
        // move。
        const used = await isSubjectUsed(tx, id);
        if (used) {
          throw new HTTPError(422, `科目 ${before.code} 已关联数据,不得删除/移动/改叶节点属性`);
        }
      }
    }

    // 应用 afterSnapshot。
    await applyAfterSnapshot(tx, app.projectId, beforeSnapshot, afterSnapshot);

    const updated = await tx.subjectChangeApplication.update({
      where: { id: appId },
      data: {
        status: ApprovalStatus.APPROVED,
        approverId: user.id,
      },
    });

    const trimmedOpinion = opinion?.trim() ? opinion.trim() : null;
    await recordAudit(tx, {
      projectId: app.projectId,
      objectType: 'subject_change_applications',
      objectId: appId,
      action: 'approve',
      operatorId: user.id,
      before: snapshotApplication(app),
      after: { ...snapshotApplication(updated), opinion: trimmedOpinion },
    });

    return updated;
  });
}

/** §5.3 驳回(PENDING → REJECTED)。 */
export async function rejectSubjectChange(
  appId: string,
  user: Pick<User, 'id' | 'role'>,
  opinion: string,
): Promise<SubjectChangeApplication> {
  const app = await prisma.subjectChangeApplication.findUnique({ where: { id: appId } });
  if (!app) {
    throw new HTTPError(404, '科目变更单不存在');
  }
  await requirePermission(user, 'budget:approve', app.projectId);

  if (app.status !== ApprovalStatus.PENDING) {
    throw new HTTPError(409, `当前状态 ${app.status} 不允许驳回,仅 PENDING 可驳回`);
  }

  const trimmedOpinion = opinion?.trim() ? opinion.trim() : null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.subjectChangeApplication.update({
      where: { id: appId },
      data: {
        status: ApprovalStatus.REJECTED,
        approverId: user.id,
      },
    });
    await recordAudit(tx, {
      projectId: app.projectId,
      objectType: 'subject_change_applications',
      objectId: appId,
      action: 'reject',
      operatorId: user.id,
      before: snapshotApplication(app),
      after: { ...snapshotApplication(updated), opinion: trimmedOpinion },
    });
    return updated;
  });
}
