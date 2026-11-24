/**
 * 经费报告(Funding Report)共享定义:汇总列与明细字段的可选池、默认选择与
 * query 参数解析。前后端共用(UI 勾选/排序 ↔ API csv 参数 ↔ 服务端校验),
 * 保证三处口径同源。列头文字沿用财务模板口径(CONTEXT.md「经费报告」)。
 */

/** 汇总表数值列(模板 5 列 + 结余 + 执行率);顺序即默认展示顺序。 */
export const SUMMARY_COLUMN_DEFS = [
  { key: 'initial', label: '合同总预算' },
  { key: 'current', label: '调整后预算' },
  { key: 'occupied', label: '实际开支情况' },
  { key: 'paid', label: '账面支出情况' },
  { key: 'payable', label: '应付未付' },
  { key: 'balance', label: '结余' },
  { key: 'rate', label: '执行率' },
] as const;

export type SummaryColumnKey = (typeof SUMMARY_COLUMN_DEFS)[number]['key'];

export const SUMMARY_COLUMN_KEYS: readonly SummaryColumnKey[] = SUMMARY_COLUMN_DEFS.map(
  (d) => d.key,
);

/** 默认勾选:模板原有 5 列。 */
export const DEFAULT_SUMMARY_COLUMNS: readonly SummaryColumnKey[] = [
  'initial',
  'current',
  'occupied',
  'paid',
  'payable',
];

/** 明细字段池(业务记录全部可展示字段 + 叶科目名);key 与 BusinessRecord 字段对应。 */
export const DETAIL_FIELD_DEFS = [
  { key: 'appliedDate', label: '申请日期' },
  { key: 'completedDate', label: '完成日期' },
  { key: 'summary', label: '摘要' },
  { key: 'amount', label: '金额(元)' },
  { key: 'handler', label: '经办人' },
  { key: 'status', label: '状态' },
  { key: 'docNo', label: '单据编号' },
  { key: 'voucherNo', label: '凭证编号' },
  { key: 'budgetYear', label: '预算年度' },
  { key: 'subject', label: '科目' },
] as const;

export type DetailFieldKey = (typeof DETAIL_FIELD_DEFS)[number]['key'];

export const DETAIL_FIELD_KEYS: readonly DetailFieldKey[] = DETAIL_FIELD_DEFS.map((d) => d.key);

/** 默认勾选:模板明细表 4 列(时间/凭证编号/金额/明细)。 */
export const DEFAULT_DETAIL_FIELDS: readonly DetailFieldKey[] = [
  'appliedDate',
  'voucherNo',
  'amount',
  'summary',
];

/** 状态展示文案(与记录页 STATUS_LABEL 同口径)。 */
export const FUNDING_REPORT_STATUS_TEXT: Record<string, string> = {
  PLACEHOLDER: '登记占位',
  CONTRACT: '合同',
  FINANCE_APPROVAL: '财务系统审批',
  RETURNED: '业务退单',
  PAID: '已支出',
};

export const SUMMARY_COLUMN_LABELS: Record<SummaryColumnKey, string> = Object.fromEntries(
  SUMMARY_COLUMN_DEFS.map((d) => [d.key, d.label]),
) as Record<SummaryColumnKey, string>;

export const DETAIL_FIELD_LABELS: Record<DetailFieldKey, string> = Object.fromEntries(
  DETAIL_FIELD_DEFS.map((d) => [d.key, d.label]),
) as Record<DetailFieldKey, string>;

export type ReportLevel = number | 'all';

export interface FundingReportQueryOptions {
  level: ReportLevel;
  summaryColumns: SummaryColumnKey[];
  detailFields: DetailFieldKey[];
}

function parseKeyList<K extends string>(
  raw: string | null,
  valid: readonly K[],
  fallback: readonly K[],
): K[] {
  if (!raw) return [...fallback];
  // 超长参数直接回落默认:逗号洪泛不该变成一次大循环。
  if (raw.length > 2000) return [...fallback];
  const keys = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const picked: K[] = [];
  for (const key of keys) {
    // 未知 key 直接忽略(不报错):字段池演进时旧链接仍可用。
    const hit = valid.find((v) => v === key);
    if (hit !== undefined && !picked.includes(hit)) picked.push(hit);
  }
  return picked;
}

/** 解析页面/外部调用传入的 query 参数;缺省/非法用默认选择。不校验非空(服务层职责)。 */
export function parseFundingReportOptions(params: URLSearchParams): FundingReportQueryOptions {
  const levelRaw = params.get('level');
  let level: ReportLevel;
  if (levelRaw === 'all') {
    level = 'all';
  } else if (levelRaw && /^[1-9]\d{0,1}$/.test(levelRaw)) {
    // 层级上限 99(一级科目中文编号的覆盖范围);树深裁剪在服务层按实际树深收。
    level = Number.parseInt(levelRaw, 10);
  } else {
    level = 2;
  }
  return {
    level,
    summaryColumns: parseKeyList(
      params.get('summary'),
      SUMMARY_COLUMN_KEYS,
      DEFAULT_SUMMARY_COLUMNS,
    ),
    detailFields: parseKeyList(params.get('fields'), DETAIL_FIELD_KEYS, DEFAULT_DETAIL_FIELDS),
  };
}

/** 页面侧:把选择序列化为 query 参数(仅勾选项按列表顺序)。 */
export function serializeFundingReportOptions(options: FundingReportQueryOptions): string {
  const params = new URLSearchParams();
  params.set('level', options.level === 'all' ? 'all' : String(options.level));
  if (options.summaryColumns.length > 0) {
    params.set('summary', options.summaryColumns.join(','));
  }
  if (options.detailFields.length > 0) {
    params.set('fields', options.detailFields.join(','));
  }
  return params.toString();
}
