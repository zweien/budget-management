import ExcelJS from 'exceljs';

/**
 * §10 Excel 批量导入:模板生成与列定义。
 *
 * 仅在服务端(Route Handler / service / 测试)使用,exceljs 在 Node 运行,
 * 不打包进客户端 bundle。
 *
 * §10.4 模板表头(列顺序即解析顺序):
 *   项目编号、预算年度、科目编码、金额、业务发生日期、经办人、摘要、业务状态、备注
 */

/** §10.2/10.4 列定义:中文表头 + 对应字段键。 */
export interface ExcelColumn {
  /** 表头中文(模板首行 + 预览展示)。 */
  header: string;
  /** 解析后 parsedData 的字段键(snake_case 与 §10 文档一致)。 */
  key: string;
  /** 列宽(字符)。 */
  width: number;
}

/** §10.4 模板列(顺序敏感;解析按表头匹配,缺表头退回此顺序)。 */
export const EXCEL_COLUMNS: readonly ExcelColumn[] = [
  { header: '项目编号', key: 'projectCode', width: 18 },
  { header: '预算年度', key: 'budgetYear', width: 12 },
  { header: '科目编码', key: 'subjectCode', width: 16 },
  { header: '金额', key: 'amount', width: 14 },
  { header: '业务发生日期', key: 'businessDate', width: 16 },
  { header: '经办人', key: 'handler', width: 14 },
  { header: '摘要', key: 'summary', width: 30 },
  { header: '业务状态', key: 'businessStatus', width: 16 },
  { header: '备注', key: 'remark', width: 24 },
  // v0.11 追加(可选列):老文件无此列仍可导入,查重退回指纹疑似。
  { header: '单据编号', key: 'docNo', width: 20 },
] as const;

/** §10.2 业务状态中文 ↔ BusinessStatus 枚举映射。 */
export const STATUS_CN_TO_ENUM: Record<string, string> = {
  登记占位: 'PLACEHOLDER',
  合同: 'CONTRACT',
  财务系统审批: 'FINANCE_APPROVAL',
  已支出: 'PAID',
};

/** BusinessStatus 枚举 → 中文(用于回显)。 */
export const STATUS_ENUM_TO_CN: Record<string, string> = {
  PLACEHOLDER: '登记占位',
  CONTRACT: '合同',
  FINANCE_APPROVAL: '财务系统审批',
  PAID: '已支出',
};

/** §10 业务状态合法中文集合(用于校验/数据校验下拉)。 */
export const STATUS_CN_VALUES = Object.keys(STATUS_CN_TO_ENUM);

/** 当前模板版本号(写入 ImportBatch.templateVersion,便于后续模板演进)。 */
export const TEMPLATE_VERSION = '1.0';

/** 工作表名(模板主表)。 */
export const TEMPLATE_SHEET_NAME = '业务记录导入';

/**
 * §10.4 生成 .xlsx 模板文件 Buffer。
 *
 * 包含:
 * - 首行表头(加粗 + 背景色 + 冻结)。
 * - 「业务状态」列数据校验(list 下拉:四态中文)。
 * - 「金额」列数据校验(>0 的十进制)。
 * - 第二行填写说明(灰字注释行)。
 * - 列宽自适应。
 *
 * 返回 Node Buffer(可作 Response body)。
 */
export async function generateTemplateBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'budget-management';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(TEMPLATE_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // 列定义(表头 + 宽度)。
  sheet.columns = EXCEL_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
  }));

  // 表头样式:加粗、居中、浅蓝底。
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
  });

  // 第二行:填写说明(灰字,不参与解析——解析从第 2 行开始,说明行会被视为数据行并报错,
  // 因此改为只在表头加批注 + 文件末尾的"说明"工作表,避免污染数据区)。

  // 「业务状态」列(第 8 列)数据校验:四态下拉。
  const statusColIdx = EXCEL_COLUMNS.findIndex((c) => c.key === 'businessStatus') + 1;
  sheet.getCell(1, statusColIdx).note = {
    texts: [{ text: `可选值:${STATUS_CN_VALUES.join(' / ')}` }],
  };
  for (let r = 2; r <= 200; r++) {
    const cell = sheet.getCell(r, statusColIdx);
    cell.dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${STATUS_CN_VALUES.join(',')}"`],
      showErrorMessage: true,
      errorTitle: '业务状态无效',
      error: `请从以下值中选择:${STATUS_CN_VALUES.join(' / ')}`,
    };
  }

  // 「金额」列(第 4 列)数据校验:大于 0 的十进制。
  const amountColIdx = EXCEL_COLUMNS.findIndex((c) => c.key === 'amount') + 1;
  sheet.getCell(1, amountColIdx).note = {
    texts: [{ text: '金额必须大于 0,例如 1000.00' }],
  };
  for (let r = 2; r <= 200; r++) {
    const cell = sheet.getCell(r, amountColIdx);
    cell.dataValidation = {
      type: 'decimal',
      operator: 'greaterThan',
      allowBlank: true,
      formulae: [0],
      showErrorMessage: true,
      errorTitle: '金额无效',
      error: '金额必须为大于 0 的数字',
    };
  }

  // 「业务发生日期」列(第 5 列)格式提示(文本日期 yyyy-mm-dd)。
  const dateColIdx = EXCEL_COLUMNS.findIndex((c) => c.key === 'businessDate') + 1;
  sheet.getCell(1, dateColIdx).note = {
    texts: [{ text: '日期格式:YYYY-MM-DD(例如 2026-07-30)' }],
  };

  // 「单据编号」列预格式化为文本(codex P2):防止 Excel 把 00123/超 15 位编号
  // 强转数值,导致上传后与既有编号对不上、绕过硬重复。
  const docNoColIdx = EXCEL_COLUMNS.findIndex((c) => c.key === 'docNo') + 1;
  if (docNoColIdx > 0) {
    for (let r = 2; r <= 200; r++) {
      sheet.getCell(r, docNoColIdx).numFmt = '@';
    }
  }

  // 追加一个"填写说明"工作表。
  const guide = workbook.addWorksheet('填写说明');
  guide.getColumn(1).width = 24;
  guide.getColumn(2).width = 80;
  const guideRows: [string, string][] = [
    ['字段', '说明'],
    ['项目编号', '必须与当前项目编号一致(系统校验)。'],
    ['预算年度', '正整数,例如 2026。'],
    ['科目编码', '必须是该项目下已存在的【叶节点】科目编码(非叶节点会报错)。'],
    ['金额', '大于 0 的数字,例如 1000.00。'],
    ['业务发生日期', 'YYYY-MM-DD 文本日期。'],
    ['经办人', '非空。'],
    ['摘要', '非空。'],
    ['业务状态', `四选一:${STATUS_CN_VALUES.join(' / ')}。`],
    ['备注', '可选。'],
    [
      '单据编号',
      '可选。财务系统单据号;项目内与未作废记录同号即【硬重复】,禁止导入(先作废旧记录方可重导)。',
    ],
    ['', ''],
    [
      '重复检测',
      '填了单据编号:与项目内未作废记录同号 → 硬重复,禁止导入。未填编号:按(年度+金额+业务日期+摘要)匹配 → 疑似重复,默认不导入,可在确认页勾选强制导入。',
    ],
    ['超预算', '超预算行允许导入(仅在台账中体现),不会被拒绝。'],
  ];
  guideRows.forEach(([k, v], i) => {
    const row = guide.getRow(i + 1);
    row.values = [k, v];
    if (i === 0) {
      row.font = { bold: true };
    }
  });

  const buf = await workbook.xlsx.writeBuffer();
  // exceljs 返回 ArrayBuffer/Buffer 视情况;统一为 Node Buffer。
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}
