/**
 * 结算单查询 Excel(财务系统导出)格式定义。两种版式长期并存:
 * - v1(填制日期版):单据编号/单据状态/填制日期/事项/金额/经办人。
 * - v2(申请日期版,0.12 起):单据编号/单据状态/申请日期/完成日期/金额/经办人/备注
 *   等(另有 单位/部门/单据类型/业务类型/合同编号/制单人/补录标识,忽略不导入;
 *   摘要取「备注」列)。
 *
 * 与系统标准模板(src/lib/excel/template.ts)并存:
 * - 表头不在首行(位于前 N 行内,按「单据编号」+「单据状态」定位)。
 * - 无科目列,科目在预览页由用户逐条指定。
 * - 单据状态为财务系统枚举,需映射到 BusinessStatus。
 *
 * 仅在服务端使用(exceljs 在 Node 运行);常量可被客户端安全导入(纯数据)。
 */

/** 结算单批次模板版本(写入 ImportBatch.templateVersion;两种版式共用)。 */
export const SETTLEMENT_TEMPLATE_VERSION = 'settlement-1.0';

/** 表头行定位:前 N 行内出现「单据编号」+「单据状态」即认定为本格式(v1/v2 皆然)。 */
export const SETTLEMENT_HEADER_SCAN_ROWS = 10;

/** 结算单表头名(按名匹配列,不依赖列序)。v1 必需 fillDate/subject;v2 必需 applyDate/remark。 */
export const SETTLEMENT_HEADERS = {
  docNo: '单据编号',
  docStatus: '单据状态',
  fillDate: '填制日期',
  subject: '事项',
  amount: '金额',
  handler: '经办人',
  /** v2:申请日期(即 v1 的填制日期)。 */
  applyDate: '申请日期',
  /** v2:完成日期(仅完成记账后才有值;可空)。 */
  completeDate: '完成日期',
  /** v2:摘要来源。 */
  remark: '备注',
} as const;

/**
 * v2(申请日期版)判定:表头含「申请日期」即 v2;否则若含「填制日期」为 v1。
 */
export const SETTLEMENT_V2_APPLY_DATE = '申请日期';

/** 单据状态 → BusinessStatus 映射(两种版式同表)。 */
export const SETTLEMENT_STATUS_TO_ENUM: Record<string, 'PAID' | 'FINANCE_APPROVAL'> = {
  完成记账: 'PAID',
  // 以下均为「尚未记账」的在途单据 → 财务系统审批(payable):
  // 制单保存(v1)、打印审签/完成审核(v2 实际出现)。
  制单保存: 'FINANCE_APPROVAL',
  打印审签: 'FINANCE_APPROVAL',
  完成审核: 'FINANCE_APPROVAL',
};

/** 业务退单:不导入(解析时跳过,仅保留行供预览页提示条数)。 */
export const SETTLEMENT_SKIPPED_STATUS = '业务退单';
