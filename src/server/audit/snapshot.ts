import { Prisma } from '@prisma/client';

/**
 * 把一行记录序列化为可存 JSONB 的快照对象(§14.1 before/after 整行快照)。
 * Prisma.Decimal → 字符串;Date → ISO 字符串;其余原样。
 */
export function snapshotRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Prisma.Decimal) {
      // schema 金额列均为 Decimal(18,2);toFixed(2) 保留 2 位小数,避免 100.50 → '100.5' 的尾零丢失
      out[k] = v.toFixed(2);
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}
