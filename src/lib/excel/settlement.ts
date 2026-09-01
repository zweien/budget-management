/**
 * 个人结算单查询 Excel(财务系统导出)格式定义。
 *
 * 与系统标准模板(src/lib/excel/template.ts)并存的第二种导入源格式:
 * - 表头不在首行,位于第 4 行(前 3 行为标题/时间/单位)。
 * - 无科目列,科目在预览页由用户逐条指定。
 * - 单据状态为财务系统枚举,需映射到 BusinessStatus。
 *
 * 仅在服务端使用(exceljs 在 Node 运行);常量可被客户端安全导入(纯数据)。
 */

/** 结算单批次模板版本(写入 ImportBatch.templateVersion)。 */
export const SETTLEMENT_TEMPLATE_VERSION = 'settlement-1.0';

/** 表头行定位:前 N 行内出现「单据编号」+「单据状态」即认定为本格式。 */
export const SETTLEMENT_HEADER_SCAN_ROWS = 10;

/** 结算单表头名(按名匹配列,不依赖列序)。 */
export const SETTLEMENT_HEADERS = {
  docNo: '单据编号',
  docStatus: '单据状态',
  fillDate: '填制日期',
  subject: '事项',
  amount: '金额',
  handler: '经办人',
} as const;

/** 单据状态 → BusinessStatus 映射。 */
export const SETTLEMENT_STATUS_TO_ENUM: Record<string, 'PAID' | 'FINANCE_APPROVAL'> = {
  完成记账: 'PAID',
  制单保存: 'FINANCE_APPROVAL',
};

/** 业务退单:不导入(解析时跳过,仅保留行供预览页提示条数)。 */
export const SETTLEMENT_SKIPPED_STATUS = '业务退单';
