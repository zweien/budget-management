import { format } from 'date-fns';

/** ISO 时间字符串 → 'yyyy-MM-dd HH:mm';无效值/空值显示 '—'。 */
export function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm');
}
