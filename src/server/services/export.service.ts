import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { HTTPError } from '@/lib/auth/session';
import { fromStored } from '@/lib/decimal';
import { STATUS_ENUM_TO_CN } from '@/lib/excel/template';
import { getProjectLedger, type LedgerNode } from '@/server/services/ledger.service';
import {
  balanceStatistics,
  customStatistics,
  prepareRecordSelection,
  type BalanceStatisticsFilters,
  type CustomStatisticsFilters,
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

// 导出投影不含未使用的业务字段和附件二进制；记录页不需要附件计数。
const exportRecordSelect = {
  id: true,
  budgetYear: true,
  businessDate: true,
  completedDate: true,
  amount: true,
  status: true,
  isVoid: true,
  docNo: true,
  handler: true,
  summary: true,
  remark: true,
  enteredAt: true,
  createdAt: true,
  project: { select: { code: true, name: true } },
  subject: { select: { code: true, name: true } },
  createdBy: { select: { name: true } },
} satisfies Prisma.BusinessRecordSelect;
type ExportRecord = Omit<
  Prisma.BusinessRecordGetPayload<{ select: typeof exportRecordSelect }>,
  'createdBy'
> & {
  creatorName: string | null;
  attachmentCount: number;
};

async function* readExportRecords(
  ids: string[],
  withCounts: boolean,
): AsyncGenerator<ExportRecord> {
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const [rows, counts] = await Promise.all([
      prisma.businessRecord.findMany({ where: { id: { in: chunk } }, select: exportRecordSelect }),
      withCounts
        ? prisma.recordAttachment.groupBy({
            by: ['recordId'],
            where: { recordId: { in: chunk } },
            _count: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const countById = new Map(counts.map((row) => [row.recordId, row._count.id]));
    for (const id of chunk) {
      const row = byId.get(id);
      if (!row) throw new HTTPError(409, '导出期间记录已删除，请重试');
      const { createdBy, ...record } = row;
      yield {
        ...record,
        creatorName: createdBy?.name ?? null,
        attachmentCount: countById.get(id) ?? 0,
      };
    }
  }
}

/** 释放已提交的Row/Cell，仅在内存保留压缩后的文件，错误时也收尾内存归档。 */
async function writeStreamingWorkbook(
  write: (workbook: ExcelJS.stream.xlsx.WorkbookWriter) => Promise<void>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'budget-management';
  try {
    await write(workbook);
  } catch (error) {
    await workbook.commit().catch(() => {});
    throw error;
  }
  await workbook.commit();
  return Buffer.concat(chunks);
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
 * - 明细表头 + 明细行(业务记录;列集与统计页对齐,另含编号列供对账)。
 */
export async function exportStatistics(
  filters: CustomStatisticsFilters,
  user: ExportUser,
  tz?: { enteredAtOffsetMinutes?: number; layout?: 'records' },
): Promise<Buffer> {
  const selection = await prepareRecordSelection(filters, user);
  // 固定本次筛选的成员与顺序，只取 cap+1 个ID；不因后续新增/排序变化发生漏行或重复。
  const selected = await prisma.businessRecord.findMany({
    where: selection.where,
    orderBy: selection.orderBy,
    select: { id: true },
    take: env.MAX_EXPORT_ROWS + 1,
  });
  if (selected.length > env.MAX_EXPORT_ROWS) {
    throw new HTTPError(413, `导出行数超过上限 ${env.MAX_EXPORT_ROWS},请增加筛选条件缩小范围`);
  }
  const records = readExportRecords(
    selected.map((row) => row.id),
    tz?.layout !== 'records',
  );

  // 2) 元信息:操作人姓名 + 项目编号/名称(筛选描述用,避免打印 UUID)。
  const [operator, project] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true },
    }),
    filters.projectId
      ? prisma.project.findUnique({
          where: { id: filters.projectId },
          select: { code: true, name: true },
        })
      : Promise.resolve(null),
  ]);

  if (tz?.layout === 'records') {
    return exportRecordList(records, project, filters.entryTimeField, tz.enteredAtOffsetMinutes);
  }

  // 3) 构造 workbook。
  const result = await customStatistics({ ...filters, page: 1, pageSize: 1 }, user);
  return writeStreamingWorkbook(async (workbook) => {
    const sheet = workbook.addWorksheet('自定义统计');

    // 元信息:筛选条件。
    const filterDesc = describeFilters(filters, project);
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
      '项目名称',
      '预算年度',
      '科目编码',
      '科目名称',
      '金额',
      '经办人',
      '摘要',
      '业务状态',
      '是否作废',
      '完成日期',
      '单据编号',
      '备注',
      '录入时间',
      '录入人',
      '附件数',
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

    // 列宽。
    sheet.getColumn(1).width = 18;
    for (let c = 2; c <= headers.length; c++) {
      sheet.getColumn(c).width = 16;
    }

    headerRow.commit();

    // 明细数据行。
    let r = headerRowIdx + 1;
    for await (const rec of records) {
      const row = sheet.getRow(r);
      row.values = statisticsRecordRow(rec, tz);
      row.commit();
      if (++r % 128 === 0) await yieldToEventLoop();
    }
  });
}

/** 记录页的筛选全集；沿用数值金额、中文状态、冻结表头和项目标题。 */
async function exportRecordList(
  records: AsyncIterable<ExportRecord>,
  project: { code: string; name: string } | null,
  entryTimeField: 'enteredAt' | 'createdAt' = 'createdAt',
  offsetMinutes?: number,
): Promise<Buffer> {
  return writeStreamingWorkbook(async (workbook) => {
    const sheet = workbook.addWorksheet('业务记录', {
      views: [{ state: 'frozen', ySplit: project ? 2 : 1 }],
    });
    const headers = [
      '项目',
      '年度',
      '科目',
      '申请日期',
      '完成日期',
      '金额',
      '状态',
      '单据编号',
      '经办人',
      '摘要',
      '备注',
      '录入人',
      '录入时间',
    ];
    const widths = [24, 8, 22, 12, 12, 14, 10, 20, 10, 32, 28, 10, 17];
    if (project) {
      sheet.mergeCells(1, 1, 1, headers.length - 1);
      sheet.getCell('A1').value = `${project.name} 业务记录(筛选结果)`;
      sheet.getCell('A1').font = { bold: true, size: 13 };
    }
    (project ? widths.slice(1) : widths).forEach((width, i) => {
      sheet.getColumn(i + 1).width = width;
    });
    const header = sheet.addRow(project ? headers.slice(1) : headers);
    header.font = { bold: true };
    header.commit();
    let written = 0;
    for await (const rec of records) {
      const values = [
        `${rec.project.code} ${rec.project.name}`,
        rec.budgetYear,
        rec.subject.name,
        toIsoDate(rec.businessDate),
        rec.completedDate ? toIsoDate(rec.completedDate) : '',
        fromStored(rec.amount).toNumber(),
        rec.isVoid ? '已作废' : (STATUS_ENUM_TO_CN[rec.status] ?? rec.status),
        rec.docNo ?? '',
        rec.handler,
        rec.summary,
        rec.remark ?? '',
        rec.creatorName ?? '',
        // 两个记录页原有时间字段不同，保持各页口径。
        toIsoDateTime(rec[entryTimeField], offsetMinutes).slice(0, 16),
      ];
      const row = sheet.addRow(project ? values.slice(1) : values);
      row.getCell(project ? 5 : 6).numFmt = '#,##0.00';
      row.commit();
      // 大导出不能长时间占用处理日常查询与保存的事件循环。
      if (++written % 128 === 0) await yieldToEventLoop();
    }
  });
}

/** 单条业务记录 → 行数组。金额字符串(2 位小数),业务/完成日期 ISO,录入时间按用户时区。 */
function statisticsRecordRow(
  rec: ExportRecord,
  tz?: { enteredAtOffsetMinutes?: number },
): (string | number)[] {
  return [
    toIsoDate(rec.businessDate),
    rec.project?.code ?? '',
    rec.project?.name ?? '',
    rec.budgetYear,
    rec.subject?.code ?? '',
    rec.subject?.name ?? '',
    // rec.amount 是 Prisma Decimal,统一转 2 位小数字符串(§global 金额字符串传输)。
    fromStored(rec.amount).toFixed(2),
    rec.handler ?? '',
    rec.summary ?? '',
    rec.status,
    rec.isVoid ? '是' : '否',
    rec.completedDate ? toIsoDate(rec.completedDate) : '',
    rec.docNo ?? '',
    rec.remark ?? '',
    toIsoDateTime(rec.enteredAt, tz?.enteredAtOffsetMinutes),
    rec.creatorName ?? '',
    rec.attachmentCount,
  ];
}

/** 将 filters 渲染为人类可读的筛选条件描述(项目用编号+名称,不用 UUID)。 */
function describeFilters(
  filters: CustomStatisticsFilters,
  project?: { code: string; name: string } | null,
): string {
  const parts: string[] = [];
  if (filters.projectId) {
    parts.push(`项目=${project ? `${project.code} ${project.name}` : filters.projectId}`);
  }
  if (filters.budgetYear !== undefined) parts.push(`年度=${filters.budgetYear}`);
  if (filters.subject) parts.push(`科目=${filters.subject}`);
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

/**
 * Date → yyyy-MM-dd HH:mm:ss。
 * 给定 offsetMinutes(浏览器 Date#getTimezoneOffset 值,UTC+8 = -480)时,
 * 用 UTC 刻度平移取墙面时间,按用户时区渲染(codex P2:与页面显示一致,不随服务器时区漂移);
 * 未给定时按服务器本地时区(formatNow 元信息沿用)。
 */
function toIsoDateTime(d: Date, offsetMinutes?: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (t: Date, utc: boolean) =>
    utc
      ? `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
      : `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  if (typeof offsetMinutes === 'number' && Number.isFinite(offsetMinutes)) {
    return fmt(new Date(d.getTime() - offsetMinutes * 60_000), true);
  }
  return fmt(d, false);
}

/** 当前时间 → yyyy-MM-dd HH:MM:SS(本地时区描述,导出时刻)。 */
function formatNow(): string {
  return toIsoDateTime(new Date());
}

// ---------------- 经费余额导出 ----------------

/**
 * 导出经费余额统计(总预算口径)。
 *
 * 权限:复用 balanceStatistics 内部逻辑(所有登录用户可查)。
 *
 * xlsx 结构:元信息(筛选条件/导出时间/操作人)+ 合计行(去重叶集合口径)
 * + 明细表头 + 逐行(项目 × 科目)。年度三列仅选定年度时输出。
 */
export async function exportBalanceStatistics(
  filters: BalanceStatisticsFilters,
  user: ExportUser,
): Promise<Buffer> {
  const result = await balanceStatistics(filters, user);

  const operator = await prisma.user.findUnique({
    where: { id: user.id },
    select: { name: true },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'budget-management';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('经费余额');

  const descParts: string[] = [];
  descParts.push(filters.subject ? `科目=${filters.subject}` : '科目=全部');
  if (filters.projectId) descParts.push('项目=指定');
  if (filters.year !== undefined) descParts.push(`年度=${filters.year}`);
  if (filters.onlyNegative) descParts.push('仅看结余为负');
  sheet.getCell('A1').value = `筛选条件:${descParts.join(' / ')}`;
  sheet.getCell('A2').value = `命中:${result.hitProjects} 个项目 × ${result.hitSubjects} 个科目`;
  sheet.getCell('A3').value = `导出时间:${formatNow()}`;
  sheet.getCell('A4').value = `操作人:${operator?.name ?? user.name ?? user.id}`;

  // 合计行(第 6 行)。
  const t = result.total;
  const summaryValue: (string | number)[] = [
    t.totalBudget,
    t.paid,
    t.payable,
    t.totalOccupied,
    t.balance,
    rateToPercent(t.executionRate),
  ];
  if (filters.year !== undefined) {
    summaryValue.push(t.yearBudget ?? '0.00', t.yearOccupied ?? '0.00', t.yearBalance ?? '0.00');
  }
  // B-D 列补空占位,使合计值与明细的金额列(E 起)纵向对齐。
  const totalRow = sheet.getRow(6);
  totalRow.values = ['合计(命中科目去重)', '', '', '', ...summaryValue];
  totalRow.font = { bold: true };

  // 明细表头(第 8 行)。
  const headers = [
    '项目编号',
    '项目名称',
    '科目编码',
    '科目名称',
    '科目总预算',
    '已支出',
    '应付未付',
    '总占用',
    '总结余',
    '执行率',
    ...(filters.year !== undefined ? ['年度预算', '年度占用', '年度结余'] : []),
  ];
  const headerRow = sheet.getRow(8);
  headerRow.values = headers;
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
  });

  let r = 9;
  for (const row of result.rows) {
    const line: (string | number)[] = [
      row.projectCode,
      row.projectName,
      row.subjectCode,
      row.subjectName,
      row.totalBudget,
      row.paid,
      row.payable,
      row.totalOccupied,
      row.balance,
      rateToPercent(row.executionRate),
    ];
    if (filters.year !== undefined) {
      line.push(row.yearBudget ?? '0.00', row.yearOccupied ?? '0.00', row.yearBalance ?? '0.00');
    }
    sheet.getRow(r).values = line;
    r++;
  }

  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 12;
  sheet.getColumn(4).width = 22;
  for (let c = 5; c <= headers.length; c++) sheet.getColumn(c).width = 14;

  return toBuffer(await workbook.xlsx.writeBuffer());
}

export { XLSX_MIME };
