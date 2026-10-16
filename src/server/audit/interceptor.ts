import { Prisma } from '@prisma/client';
import { snapshotRow } from './snapshot';
import { uuidv7 } from '@/lib/id';

export interface AuditContext {
  projectId?: string;
  objectType: string;
  objectId: string;
  action: string;
  operatorId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * 在业务事务内写一条审计日志(§14.1)。
 * 调用方必须传入 tx(来自 prisma.$transaction),保证日志与业务同事务、审计链不断(§14.2)。
 */
export function recordAudit(tx: Prisma.TransactionClient, ctx: AuditContext) {
  return tx.auditLog.create({
    data: auditData(ctx),
  });
}

/** 批量写入仍每条业务记录一条日志，且必须与业务写入共用事务。 */
export async function recordAudits(tx: Prisma.TransactionClient, contexts: AuditContext[]) {
  for (let i = 0; i < contexts.length; i += 500) {
    await tx.auditLog.createMany({ data: contexts.slice(i, i + 500).map(auditData) });
  }
}

function auditData(ctx: AuditContext): Prisma.AuditLogCreateManyInput {
  return {
    id: uuidv7(),
    projectId: ctx.projectId ?? null,
    objectType: ctx.objectType,
    objectId: ctx.objectId,
    action: ctx.action,
    beforeData: (ctx.before ? snapshotRow(ctx.before) : null) as Prisma.InputJsonValue,
    afterData: (ctx.after ? snapshotRow(ctx.after) : null) as Prisma.InputJsonValue,
    operatorId: ctx.operatorId,
  };
}
