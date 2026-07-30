import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';

describe('foundation smoke (prisma + audit + id)', () => {
  beforeAll(async () => {
    // 确保库可连
    await prisma.$connect();
  });

  it('uuidv7 生成合法且版本为 7', () => {
    const id = uuidv7();
    expect(id).toHaveLength(36);
    expect(id.charAt(14)).toBe('7'); // 版本位
  });

  it('事务内写审计日志成功(before/after 为 JSONB)', async () => {
    const userId = uuidv7();
    await prisma.user.create({
      data: { id: userId, name: 'tester', role: 'BUDGET_ADMIN' },
    });
    const audit = await prisma.$transaction(async (tx) =>
      recordAudit(tx, {
        objectType: 'test',
        objectId: userId,
        action: 'create',
        operatorId: userId,
        before: { amount: '0' },
        after: { amount: '100.50' },
      }),
    );
    expect(audit.afterData).toEqual({ amount: '100.50' });
    // 清理
    await prisma.auditLog.delete({ where: { id: audit.id } });
    await prisma.user.delete({ where: { id: userId } });
  });
});
