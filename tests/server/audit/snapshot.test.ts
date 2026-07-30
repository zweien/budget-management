import { describe, it, expect } from 'vitest';
import { snapshotRow } from '@/server/audit/snapshot';
import { Prisma } from '@prisma/client';

describe('snapshotRow', () => {
  it('Decimal 字段转为字符串(便于 JSONB 存储)', () => {
    const row = { id: 'x', amount: new Prisma.Decimal('100.50'), name: 'foo' };
    const snap = snapshotRow(row);
    expect(snap.amount).toBe('100.50');
    expect(snap.name).toBe('foo');
  });

  it('null 与 Date 保留原样(Date 转 ISO 字符串)', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const snap = snapshotRow({ id: 'x', date: d, nullable: null });
    expect(snap.nullable).toBeNull();
    expect(snap.date).toBe(d.toISOString());
  });
});
