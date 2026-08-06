import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { fromStored } from '@/lib/decimal';
import { getProjectLedger, type LedgerNode } from '@/server/services/ledger.service';
import {
  customStatistics,
  type CustomStatisticsFilters,
  type CustomStatisticsResult,
} from '@/server/services/statistics.service';

/**
 * §10.5 导出服务:用 exceljs 生成 xlsx Buffer。
 *
 * 每个导出表都含元信息行:筛选条件(或项目编号/名称+年度)/ 导出时间 / 操作人。
 * 金额一律字符串(.toFixed(2));executionRate 渲染为百分比字符串。
 * 复用既有 services(getProjectLedger / customStatistics),权限由它们内部再校验。
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * 导出函数的用户入参。需带 id/role 以满足底层 services 的权限校验
 * (getProjectLedger / customStatistics 均要求 Pick<User,'id'|'role'>);name 可选,
 * 取不到时退回用 user.name 或 user.id 作为操作人展示。
 */
export type ExportUser = { id: string; role: UserRole; name?: string };

/** exceljs.writeBuffer 返回 ArrayBuffer | Buffer,统一为 Node Buffer。 */
async function toBuffer(
  buf: Awaited<ReturnType<ExcelJS.Workbook['xlsx']['writeBuffer']>>,
): Promise<Buffer> {
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/** executionRate(number|null)→ 百分比字符串,null 显示空。 */
function rateToPercent(rate: number | null): string {
  if (rate === null || Number.isNaN(rate)) return '';
  // 保留两位小数百分比(0.5833 → 58.33%)。
  return `${(rate * 100).toFixed(2)}%`;
}

/** 用 level 生成树形缩进前缀(level 从 0 起)。 */
function indent(level: number): string {
  return level > 0 ? `${'  '.repeat(level)}` : '';
}

// ---------------- 台账导出 ----------------

/**
 * §10.5 导出项目某年度的预算执行台账。
 *
 * 权限:复用 getProjectLedger 内部的 project:view + 项目范围校验。
 *
 * xlsx 结构:
 * - 第 1 行:项目编号/名称(合并说明)。
 * - 第 2 行:年度。
 * - 第 3 行:导出时间(当前时间)。
 * - 第 4 行:操作人(user.name,取 prisma.user.findUnique)。
 * - 空行间隔。
 * - 表头行:预算科目 / 初始预算 / 预算调整 / 当前预算 / 已支出 / 应付未付 / 总占用 / 结余 / 执行率。
 * - 数据行:ledger.nodes,预算科目按 level 缩进;金额字符串;执行率百分比。
 */
export async function exportLedger(
  projectId: string,
  year: number,
  user: ExportUser,
): Promise<Buffer> {
  // 1) 复用 ledger service(内部已做权限校验 + 树形聚合 + 上卷)。
  const ledger = await getProjectLedger(projectId, year, user);

  // 2) 元信息:项目编号/名称 + 操作人姓名。
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { code: true, name: true },
  });
  const operator = await prisma.user.findUnique({
    where: { id: user.id },
    select: { name: true },
  });

  // 3) 构造 workbook。
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'budget-management';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('预算执行台账');

  // 元信息行。
  const projectName = project ? `${project.code} / ${project.name}` : projectId;
  sheet.getCell('A1').value = `项目编号/名称:${projectName}`;
  sheet.getCell('A2').value = `年度:${year}`;
  sheet.getCell('A3').value = `导出时间:${formatNow()}`;
  sheet.getCell('A4').value = `操作人:${operator?.name ?? user.name ?? user.id}`;

  // 空行间隔(第 5 行空)。
  const headerRowIdx = 6;
  const headers = [
    '预算科目',
    '初始预算',
    '预算调整',
    '当前预算',
    '已支出',
    '应付未付',
    '总占用',
    '结余',
    '执行率',
  ];
  const headerRow = sheet.getRow(headerRowIdx);
  headerRow.values = headers;
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

  // 数据行。
  let r = headerRowIdx + 1;
  for (const node of ledger.nodes) {
    const row = sheet.getRow(r);
    row.values = ledgerNodeRow(node);
    r++;
  }

  // 列宽。
  sheet.getColumn(1).width = 40;
  for (let c = 2; c <= headers.length; c++) {
    sheet.getColumn(c).width = 16;
  }

  return toBuffer(await workbook.xlsx.writeBuffer());
}

/** 单个 ledger 节点 → 行数组(预算科目带缩进,金额字符串,执行率百分比)。 */
function ledgerNodeRow(node: LedgerNode): (string | number)[] {
  return [
    `${indent(node.level)}${node.code} ${node.name}`,
    node.initial,
    node.adjustment,
    node.current,
    node.paid,
    node.payable,
    node.totalOccupied,
    node.balance,
    rateToPercent(node.executionRate),
  ];
}

// ---------------- 统计导出 ----------------

/**
 * §10.5 导出自定义统计结果。
 *
 * 权限:复用 customStatistics 内部逻辑(所有登录用户可查)。
 *
 * xlsx 结构:
 * - 元信息:筛选条件(键值对描述)/ 导出时间 / 操作人。
 * - 空行。
 * - 汇总行:当前预算 / 已支出 / 应付未付 / 总占用 / 结余 / 执行率。
 * - 空行。
 * - 明细表头 + 明细行(业务记录)。
 */
export async function exportStatistics(
  filters: CustomStatisticsFilters,
  user: ExportUser,
): Promise<Buffer> {
  // 1) 复用 statistics service(内部已做权限 + 占用计算)。
  const result = await customStatistics(filters, user);

  // 2) 元信息:操作人姓名。
  const operator = await prisma.user.findUnique({
    where: { id: user.id },
    select: { name: true },
  });

  // 3) 构造 workbook。
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'budget-management';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('自定义统计');

  // 元信息:筛选条件。
  const filterDesc = describeFilters(filters);
  sheet.getCell('A1').value = `筛选条件:${filterDesc}`;
  sheet.getCell('A2').value = `导出时间:${formatNow()}`;
  sheet.getCell('A3').value = `操作人:${operator?.name ?? user.name ?? user.id}`;

  // 汇总区(第 5 行起)。
  const summaryStart = 5;
  const summary = result.summary;
  const summaryRows: [string, string][] = [
    ['当前预算', summary.currentBudget],
    ['已支出', summary.paid],
    ['应付未付', summary.payable],
    ['总占用', summary.totalOccupied],
    ['结余', summary.balance],
    ['执行率', rateToPercent(summary.executionRate)],
  ];
  summaryRows.forEach(([k, v], i) => {
    const row = sheet.getRow(summaryStart + i);
    row.values = [k, v];
  });

  // 明细表头(空一行后)。
  const headerRowIdx = summaryStart + summaryRows.length + 1;
  const headers = [
    '业务日期',
    '项目编号',
    '预算年度',
    '科目编码',
    '科目名称',
    '金额',
    '经办人',
    '摘要',
    '业务状态',
    '是否作废',
  ];
  const headerRow = sheet.getRow(headerRowIdx);
  headerRow.values = headers;
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

  // 明细数据行。
  let r = headerRowIdx + 1;
  for (const rec of result.records) {
    const row = sheet.getRow(r);
    row.values = statisticsRecordRow(rec);
    r++;
  }

  // 列宽。
  sheet.getColumn(1).width = 18;
  for (let c = 2; c <= headers.length; c++) {
    sheet.getColumn(c).width = 16;
  }

  return toBuffer(await workbook.xlsx.writeBuffer());
}

/** 单条业务记录 → 行数组。金额字符串(2 位小数),业务日期 ISO。 */
function statisticsRecordRow(rec: CustomStatisticsResult['records'][number]): (string | number)[] {
  return [
    toIsoDate(rec.businessDate),
    rec.projectId,
    rec.budgetYear,
    rec.subject?.code ?? '',
    rec.subject?.name ?? '',
    // rec.amount 是 Prisma Decimal,统一转 2 位小数字符串(§global 金额字符串传输)。
    fromStored(rec.amount).toFixed(2),
    rec.handler ?? '',
    rec.summary ?? '',
    rec.status,
    rec.isVoid ? '是' : '否',
  ];
}

/** 将 filters 渲染为人类可读的筛选条件描述。 */
function describeFilters(filters: CustomStatisticsFilters): string {
  const parts: string[] = [];
  if (filters.projectId) parts.push(`项目=${filters.projectId}`);
  if (filters.budgetYear !== undefined) parts.push(`年度=${filters.budgetYear}`);
  if (filters.subjectId) parts.push(`科目=${filters.subjectId}`);
  if (filters.status) parts.push(`状态=${filters.status}`);
  if (filters.businessDateFrom) parts.push(`起始=${filters.businessDateFrom}`);
  if (filters.businessDateTo) parts.push(`截止=${filters.businessDateTo}`);
  if (filters.handler) parts.push(`经办人=${filters.handler}`);
  if (filters.includeVoid) parts.push('含作废');
  return parts.length > 0 ? parts.join(' / ') : '全部';
}

/** Date → ISO yyyy-mm-dd(取 UTC 避免时区漂移,businessDate 存为 UTC Date)。 */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 当前时间 → yyyy-mm-dd HH:MM:SS(本地时区描述,导出时刻)。 */
function formatNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export { XLSX_MIME };
