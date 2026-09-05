/**
 * §筛选结果导出 Excel(纯前端,exceljs 动态加载):所见即所导——
 * 行集 = 当前表头筛选可见的记录(作废行若在筛选内也导出,状态列注明),
 * 服务端无需重复实现过滤逻辑。
 */
import type { DateRangeFilterValue } from '@/lib/table/filter-fns';

export interface RecordExportRow {
  /** 全局页传入项目名;项目页可省略。 */
  project?: string;
  budgetYear: number;
  subject: string;
  /** 原始 yyyy-MM-dd 或 ISO 串。 */
  businessDate: string;
  completedDate?: string | null;
  amount: string;
  /** 已格式化的状态文案(含「已作废」)。 */
  status: string;
  docNo?: string | null;
  handler: string;
  summary: string;
  remark?: string | null;
  creatorName?: string | null;
  enteredAt?: string | null;
}

export interface RecordExportOptions {
  /** 下载文件名(不含扩展名)。 */
  fileName: string;
  /** 工作表标题行(如项目名);省略则不加标题。 */
  title?: string;
}

/** 本地时区 yyyy-MM-dd(不用 toISOString:东八区本地午夜会回退一天)。 */
function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateCell(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : toLocalDate(d);
}

function formatDateTimeCell(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${toLocalDate(d)} ${hh}:${mi}`;
}

/**
 * 生成并下载 xlsx。表头冻结 + 千分位金额列;日期统一 yyyy-MM-dd(录入时间到分)。
 */
export async function exportRecordsToXlsx(
  rows: RecordExportRow[],
  opts: RecordExportOptions,
): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('业务记录');

  const headerOffset = opts.title ? 2 : 0;
  if (opts.title) {
    ws.mergeCells(1, 1, 1, 13);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = opts.title;
    titleCell.font = { bold: true, size: 13 };
    ws.getRow(1).height = 22;
  }

  const columns: { header: string; width: number }[] = [
    { header: '项目', width: 24 },
    { header: '年度', width: 8 },
    { header: '科目', width: 22 },
    { header: '申请日期', width: 12 },
    { header: '完成日期', width: 12 },
    { header: '金额', width: 14 },
    { header: '状态', width: 10 },
    { header: '单据编号', width: 20 },
    { header: '经办人', width: 10 },
    { header: '摘要', width: 32 },
    { header: '备注', width: 28 },
    { header: '录入人', width: 10 },
    { header: '录入时间', width: 17 },
  ];
  // 项目页无项目列时整体前移(隐藏首列比删列更稳,保持两页同一生成逻辑)。
  const withProject = rows.some((r) => r.project !== undefined);
  const usedColumns = withProject ? columns : columns.slice(1);

  ws.columns = usedColumns.map((c) => ({ header: c.header, width: c.width }));
  const headerRow = ws.getRow(headerOffset + 1);
  headerRow.font = { bold: true };
  headerRow.height = 18;

  for (const r of rows) {
    const values = withProject
      ? [
          r.project ?? '',
          r.budgetYear,
          r.subject,
          formatDateCell(r.businessDate),
          formatDateCell(r.completedDate),
          Number(r.amount),
          r.status,
          r.docNo ?? '',
          r.handler,
          r.summary,
          r.remark ?? '',
          r.creatorName ?? '',
          formatDateTimeCell(r.enteredAt),
        ]
      : [
          r.budgetYear,
          r.subject,
          formatDateCell(r.businessDate),
          formatDateCell(r.completedDate),
          Number(r.amount),
          r.status,
          r.docNo ?? '',
          r.handler,
          r.summary,
          r.remark ?? '',
          r.creatorName ?? '',
          formatDateTimeCell(r.enteredAt),
        ];
    const row = ws.addRow(values);
    // 金额列:千分位两位小数(Excel 数值,可直接求和)。
    const amountCell = row.getCell(withProject ? 6 : 5);
    amountCell.numFmt = '#,##0.00';
  }

  ws.views = [{ state: 'frozen', ySplit: headerOffset + 1 }];
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${opts.fileName}.xlsx`;
  a.click();
  // 立即 revoke 可能打断 headless/弱网下的 blob 落盘,延迟回收。
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 日期筛选值的人话描述(供条件 chips 与导出前提示共用)。 */
export function describeDateRangeValue(v: unknown): string {
  const r = v as DateRangeFilterValue | undefined;
  if (!r) return '全部';
  if (r.empty) return '仅看无完成日期';
  const fmt = (d?: Date | string) => {
    if (!d) return '';
    const date = new Date(d);
    return Number.isNaN(date.getTime()) ? '' : toLocalDate(date);
  };
  const from = fmt(r.from);
  const to = fmt(r.to);
  if (from && to) return `${from} ~ ${to}`;
  if (from) return `≥ ${from}`;
  if (to) return `≤ ${to}`;
  return '全部';
}
