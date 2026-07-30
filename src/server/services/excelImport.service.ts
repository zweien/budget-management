import ExcelJS from 'exceljs';
import { BusinessStatus, ImportRow, Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { D, ZERO, fromStored, toStored } from '@/lib/decimal';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';
import {
  EXCEL_COLUMNS,
  STATUS_CN_TO_ENUM,
  TEMPLATE_SHEET_NAME,
  TEMPLATE_VERSION,
} from '@/lib/excel/template';

/**
 * §10 Excel 批量导入服务。
 *
 * 两阶段流程:
 *  1. parseAndValidate —— 解析 xlsx + 逐行校验(§10.2)+ 疑似重复检测(§10.3),
 *     创建 ImportBatch(status='pending')与 ImportRow,不写业务记录,返回 batchId 供预览。
 *  2. confirmImport —— 用户在预览页勾选有效行(可含强制导入的重复行),逐行写
 *     business_record(超预算仍允许,§10.2),batch status → 'confirmed'。
 *
 * 金额一律字符串(§global);主键 UUID v7;审计 recordAudit(tx) 同事务。
 */

/** §10 一行解析后的字段(parsedData 的结构)。 */
export interface ParsedRowData {
  projectCode: string | null;
  budgetYear: string | null;
  subjectCode: string | null;
  amount: string | null;
  businessDate: string | null;
  handler: string | null;
  summary: string | null;
  businessStatus: string | null; // 中文原文
  remark: string | null;
}

/** 单行字段级错误(§10.2 错误定位到 row+field)。 */
export interface RowFieldError {
  field: string;
  message: string;
}

/** 预览页分组后的单行(同时覆盖 valid / error / duplicate 三类)。 */
export interface PreviewRow {
  rowId: string;
  rowNo: number;
  parsedData: ParsedRowData;
  validationStatus: 'valid' | 'error';
  errors: RowFieldError[];
  duplicateFlag: boolean;
  forcedImport: boolean;
  /** 解析得到的标准化金额(2 位小数字符串,便于展示;错误行可能为 null)。 */
  normalizedAmount: string | null;
  /** 解析得到的业务状态枚举(便于展示;错误行可能为 null)。 */
  normalizedStatus: BusinessStatus | null;
  /** 解析得到的科目 id(有效行才有)。 */
  subjectId: string | null;
}

/** getImportBatch 返回:三分组。 */
export interface ImportBatchPreview {
  batchId: string;
  projectId: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  valid: PreviewRow[];
  errors: PreviewRow[];
  duplicates: PreviewRow[];
}

/** confirmImport 返回。 */
export interface ConfirmResult {
  created: number;
  batchId: string;
}

// ---------- 解析辅助 ----------

/** 把 exceljs 单元格读成字符串(数字/日期均转字符串)。 */
function cellToString(cell: ExcelJS.Cell | undefined | null): string | null {
  if (cell === null || cell === undefined) return null;
  const v = cell.value;
  if (v === null || v === undefined) return null;

  // 日期类型:exceljs 可能返回 Date(带数字格式 14+)或 {result}。
  if (v instanceof Date) {
    return formatYmd(v);
  }
  if (typeof v === 'number') {
    // 数字可能是年度/金额。金额保留原始数值字符串;后续再规范化。
    if (Number.isFinite(v)) {
      return Number.isInteger(v) ? String(v) : String(v);
    }
    return null;
  }
  if (typeof v === 'boolean') {
    return String(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length === 0 ? null : s;
  }
  // 超链接/公式对象等:取 .result / .text。
  const obj = v as { result?: unknown; text?: string; hyperlink?: string };
  if (obj && typeof obj === 'object') {
    if (obj.result instanceof Date) return formatYmd(obj.result);
    if (typeof obj.result === 'string') return obj.result.trim() || null;
    if (typeof obj.result === 'number') return String(obj.result);
    if (typeof obj.text === 'string') return obj.text.trim() || null;
  }
  return null;
}

/** Date → 'YYYY-MM-DD'(UTC,避免时区漂移)。 */
function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 校验 YYYY-MM-DD 文本可解析为合法日期,返回规范化字符串。 */
function normalizeDate(s: string | null): string | null {
  if (!s) return null;
  // 已是 Date 转出的 yyyy-mm-dd 直通;也接受手填文本。
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const dt = new Date(`${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return formatYmd(dt);
}

/** 校验金额字符串 > 0,返回 2 位小数字符串;失败返回 null。 */
function normalizeAmount(s: string | null): string | null {
  if (s === null || s === '') return null;
  let d: D;
  try {
    d = new D(s);
  } catch {
    return null;
  }
  if (!d.isFinite() || d.lte(ZERO)) return null;
  return d.toFixed(2);
}

/** 校验年度正整数(1900~9999)。 */
function normalizeYear(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1900 || n > 9999) return null;
  return n;
}

// ---------- parseAndValidate ----------

/**
 * §10.1/10.2 阶段一:解析 + 校验 + 疑似重复检测。
 *
 * - 权限:record:import + 项目范围。
 * - exceljs 读 buffer;每数据行(第 2 行起)按 §10.4 列序映射。
 * - 校验:项目编号匹配;年度正整数;科目编码为该项目叶节点;金额 > 0;
 *   业务状态合法四态;业务日期可解析;经办人/摘要非空。
 * - 疑似重复(§10.3):对有效行,按(项目+年度+科目+金额+业务日期+摘要)
 *   匹配既有 business_records(含作废?——按摘要等强匹配,作废行不算重复),
 *   命中 → duplicateFlag=true。
 * - 创建 ImportBatch(status='pending') + ImportRow(parsedData、validationStatus、
 *   errors、duplicateFlag、forcedImport=false)。不写业务记录。
 * - 返回 batchId。
 */
export async function parseAndValidate(
  fileBuffer: ArrayBuffer | Buffer,
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
  fileName = 'upload.xlsx',
): Promise<string> {
  await requirePermission(user, 'record:import', projectId);

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new HTTPError(404, '项目不存在');
  }

  // 一次性取该项目所有科目,构建 { code -> subject } 与 leaf code 集合。
  const subjects = await prisma.budgetSubject.findMany({ where: { projectId } });
  const subjectByCode = new Map(subjects.map((s) => [s.code, s]));
  const leafCodes = new Set(subjects.filter((s) => s.isLeaf).map((s) => s.code));

  // ---- 解析 xlsx ----
  // exceljs.xlsx.load 期望 Buffer;统一转换(ArrayBuffer / Buffer 均可入参)。
  // 经 unknown 转换到 load 的形参类型,规避 @types/node Buffer 泛型与 exceljs 声明的类型噪声。
  const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new HTTPError(422, '无法解析 Excel 文件:格式损坏或非 .xlsx');
  }
  const sheet = workbook.getWorksheet(TEMPLATE_SHEET_NAME) ?? workbook.worksheets[0];
  if (!sheet) {
    throw new HTTPError(422, 'Excel 文件不含任何工作表');
  }

  // 列索引:按表头匹配(更稳健);若表头缺失则退回 EXCEL_COLUMNS 顺序。
  const headerMap = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const h = cellToString(cell);
    if (h) headerMap.set(h, colNumber);
  });
  const colIndexByKey = new Map<string, number>();
  for (const col of EXCEL_COLUMNS) {
    const idx = headerMap.get(col.header);
    if (idx) colIndexByKey.set(col.key, idx);
  }
  // 表头缺失时退回顺序(第 1..N 列)。
  if (colIndexByKey.size === 0) {
    EXCEL_COLUMNS.forEach((c, i) => colIndexByKey.set(c.key, i + 1));
  }

  const parsedRows: Array<{
    rowNo: number;
    data: ParsedRowData;
    errors: RowFieldError[];
    normalized: {
      amount: string | null;
      year: number | null;
      date: string | null;
      status: BusinessStatus | null;
      subjectId: string | null;
      handler: string | null;
      summary: string | null;
    };
    duplicate: boolean;
  }> = [];

  // 数据行从第 2 行开始(第 1 行表头)。
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const get = (key: string): string | null =>
      cellToString(row.getCell(colIndexByKey.get(key) ?? 1));

    const data: ParsedRowData = {
      projectCode: get('projectCode'),
      budgetYear: get('budgetYear'),
      subjectCode: get('subjectCode'),
      amount: get('amount'),
      businessDate: get('businessDate'),
      handler: get('handler'),
      summary: get('summary'),
      businessStatus: get('businessStatus'),
      remark: get('remark'),
    };

    // 空行(全列空)跳过,不计入。
    const isEmpty = Object.values(data).every((v) => v === null || v === '');
    if (isEmpty) return;

    const errors: RowFieldError[] = [];

    // 项目编号:必须匹配当前项目。
    if (!data.projectCode) {
      errors.push({ field: 'projectCode', message: '项目编号不能为空' });
    } else if (data.projectCode !== project.code) {
      errors.push({
        field: 'projectCode',
        message: `项目编号与当前项目不符(应为 ${project.code})`,
      });
    }

    // 预算年度。
    const year = normalizeYear(data.budgetYear);
    if (year === null) {
      errors.push({ field: 'budgetYear', message: '预算年度必须是 1900~9999 的正整数' });
    }

    // 科目编码:存在 + 叶节点。
    let subjectId: string | null = null;
    if (!data.subjectCode) {
      errors.push({ field: 'subjectCode', message: '科目编码不能为空' });
    } else {
      const subj = subjectByCode.get(data.subjectCode);
      if (!subj) {
        errors.push({
          field: 'subjectCode',
          message: `科目编码不存在:${data.subjectCode}`,
        });
      } else if (!subj.isLeaf || !leafCodes.has(data.subjectCode)) {
        errors.push({
          field: 'subjectCode',
          message: `科目 ${data.subjectCode} 不是叶节点,业务记录只能登记在叶科目`,
        });
      } else {
        subjectId = subj.id;
      }
    }

    // 金额。
    const amount = normalizeAmount(data.amount);
    if (amount === null) {
      errors.push({ field: 'amount', message: '金额必须为大于 0 的数字' });
    }

    // 业务日期。
    const date = normalizeDate(data.businessDate);
    if (date === null) {
      errors.push({
        field: 'businessDate',
        message: '业务发生日期格式无效(应为 YYYY-MM-DD)',
      });
    }

    // 业务状态。
    const statusCn = data.businessStatus;
    let status: BusinessStatus | null = null;
    if (!statusCn) {
      errors.push({ field: 'businessStatus', message: '业务状态不能为空' });
    } else {
      const mapped = STATUS_CN_TO_ENUM[statusCn];
      if (!mapped) {
        errors.push({
          field: 'businessStatus',
          message: `业务状态非法,仅允许 ${Object.keys(STATUS_CN_TO_ENUM).join('/')}`,
        });
      } else {
        status = mapped as BusinessStatus;
      }
    }

    // 经办人 / 摘要。
    if (!data.handler) {
      errors.push({ field: 'handler', message: '经办人不能为空' });
    }
    if (!data.summary) {
      errors.push({ field: 'summary', message: '摘要不能为空' });
    }

    parsedRows.push({
      rowNo: rowNumber,
      data,
      errors,
      normalized: {
        amount,
        year,
        date,
        status,
        subjectId,
        handler: data.handler,
        summary: data.summary,
      },
      duplicate: false,
    });
  });

  if (parsedRows.length === 0) {
    throw new HTTPError(422, 'Excel 文件不含任何有效数据行');
  }

  // ---- 疑似重复检测(仅对有效行) ----
  // 一次性拉取可能命中的既有记录(按项目 + 年度 + 科目集合缩小范围),
  // 然后在内存里按(年度+科目+金额+日期+摘要)精确匹配。
  const validRows = parsedRows.filter((r) => r.errors.length === 0);
  let existingRecords: Array<{
    budgetYear: number;
    subjectId: string;
    amount: Prisma.Decimal;
    businessDate: Date;
    summary: string;
  }> = [];
  if (validRows.length > 0) {
    const yearSet = new Set(
      validRows.map((r) => r.normalized.year).filter((y): y is number => y !== null),
    );
    const subjectIdSet = new Set(
      validRows.map((r) => r.normalized.subjectId).filter((s): s is string => s !== null),
    );
    if (yearSet.size > 0 && subjectIdSet.size > 0) {
      existingRecords = await prisma.businessRecord.findMany({
        where: {
          projectId,
          isVoid: false,
          budgetYear: { in: [...yearSet] },
          subjectId: { in: [...subjectIdSet] },
        },
        select: {
          budgetYear: true,
          subjectId: true,
          amount: true,
          businessDate: true,
          summary: true,
        },
      });
    }
  }
  const existingKeys = new Set(
    existingRecords.map((r) =>
      dupKey(r.budgetYear, r.subjectId, r.amount.toFixed(2), formatYmd(r.businessDate), r.summary),
    ),
  );
  for (const r of validRows) {
    const key = dupKey(
      r.normalized.year!,
      r.normalized.subjectId!,
      r.normalized.amount!,
      r.normalized.date!,
      r.normalized.summary!,
    );
    if (existingKeys.has(key)) r.duplicate = true;
  }

  // ---- 落库:ImportBatch + ImportRows ----
  const batchId = uuidv7();
  await prisma.$transaction(async (tx) => {
    await tx.importBatch.create({
      data: {
        id: batchId,
        projectId,
        fileName,
        templateVersion: TEMPLATE_VERSION,
        status: 'pending',
        creatorId: user.id,
      },
    });

    if (parsedRows.length > 0) {
      await tx.importRow.createMany({
        data: parsedRows.map((r) => ({
          id: uuidv7(),
          batchId,
          rowNo: r.rowNo,
          parsedData: r.data as unknown as Prisma.InputJsonValue,
          validationStatus: r.errors.length === 0 ? 'valid' : 'error',
          errors: (r.errors.length > 0 ? r.errors : null) as unknown as Prisma.InputJsonValue,
          duplicateFlag: r.duplicate,
          forcedImport: false,
        })),
      });
    }
  });

  return batchId;
}

/** 疑似重复指纹(项目维度已由查询限定,此处不含 projectId)。 */
function dupKey(
  year: number,
  subjectId: string,
  amountStr: string,
  dateStr: string,
  summary: string,
): string {
  return `${year}|${subjectId}|${amountStr}|${dateStr}|${summary}`;
}

// ---------- getImportBatch ----------

/**
 * §10 预览页数据:返回 batch + 行三分组(valid / errors / duplicates)。
 * - 权限:project:view + 项目范围(查看预览归入"查看获授权项目")。
 * - duplicate 行同时出现在 valid?——按 §10.3,duplicate 是"疑似重复的有效行",
 *   因此 valid 与 duplicates 互斥:duplicate 行只进 duplicates,不进 valid。
 */
export async function getImportBatch(
  batchId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<ImportBatchPreview> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowNo: 'asc' } } },
  });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'project:view', batch.projectId);

  const toPreview = (r: ImportRow): PreviewRow => {
    const data = r.parsedData as unknown as ParsedRowData;
    const errs = (r.errors ?? null) as unknown as RowFieldError[] | null;
    const status = data.businessStatus
      ? ((STATUS_CN_TO_ENUM[data.businessStatus] as BusinessStatus | undefined) ?? null)
      : null;
    // 标准化金额(parsedData 存的是原始字符串;此处重新规范化以便展示)。
    const normalizedAmount = normalizeAmount(data.amount);
    return {
      rowId: r.id,
      rowNo: r.rowNo,
      parsedData: data,
      validationStatus: r.validationStatus === 'valid' ? 'valid' : 'error',
      errors: errs ?? [],
      duplicateFlag: r.duplicateFlag,
      forcedImport: r.forcedImport,
      normalizedAmount,
      normalizedStatus: status,
      subjectId: null, // parsedData 只存 code;subjectId 在 confirm 时重新解析
    };
  };

  const valid: PreviewRow[] = [];
  const errors: PreviewRow[] = [];
  const duplicates: PreviewRow[] = [];
  for (const r of batch.rows) {
    const pr = toPreview(r);
    if (pr.validationStatus === 'error') {
      errors.push(pr);
    } else if (pr.duplicateFlag) {
      duplicates.push(pr);
    } else {
      valid.push(pr);
    }
  }

  return {
    batchId: batch.id,
    projectId: batch.projectId,
    fileName: batch.fileName,
    templateVersion: batch.templateVersion,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    confirmedAt: batch.confirmedAt ? batch.confirmedAt.toISOString() : null,
    valid,
    errors,
    duplicates,
  };
}

// ---------- confirmImport ----------

/**
 * §10 阶段二:确认入库。
 *
 * - 权限:record:import + 项目范围。
 * - 仅允许 status='pending' 的批次确认;已确认 → 409。
 * - selectedRowIds 必须是该批次内 validationStatus='valid' 的行(含 duplicate)。
 * - 在事务内逐行:解析字段 → 写 business_record(id=uuidv7, status 映射)。
 *   - 超预算行允许(§10.2):直接创建,over-budget 在台账自然体现。
 *   - 选中且 duplicateFlag=true 的行:置 ImportRow.forcedImport=true 留痕(§10.3),
 *     并在 business_record 的审计 after 里附 forcedImport 标记。
 * - 全部写完后:batch.status='confirmed', confirmedAt=now。
 * - 每条 business_record 单独 recordAudit(tx, import)。
 * - 返回 { created, batchId }。
 */
export async function confirmImport(
  batchId: string,
  selectedRowIds: string[],
  user: Pick<User, 'id' | 'role'>,
): Promise<ConfirmResult> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: true },
  });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'record:import', batch.projectId);

  if (batch.status === 'confirmed') {
    throw new HTTPError(409, '该批次已确认,不可重复确认');
  }

  const selectedSet = new Set(selectedRowIds);
  // 仅允许选中"valid"行(duplicate 也是 valid 子集)。
  const eligibleRows = batch.rows.filter(
    (r) => r.validationStatus === 'valid' && selectedSet.has(r.id),
  );

  // 一次性取科目映射(行里只存 code)。
  const subjects = await prisma.budgetSubject.findMany({
    where: { projectId: batch.projectId },
  });
  const subjectByCode = new Map(subjects.map((s) => [s.code, s]));

  const now = new Date();
  const createdIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    // 原子地占用批次(pending→confirming),防止并发重复确认导致业务记录重复创建。
    const claimed = await tx.importBatch.updateMany({
      where: { id: batchId, status: 'pending' },
      data: { status: 'confirming' },
    });
    if (claimed.count === 0) {
      throw new HTTPError(409, '该批次正在被确认或已确认,不可重复操作');
    }
    for (const row of eligibleRows) {
      const data = row.parsedData as unknown as ParsedRowData;
      const subj = data.subjectCode ? subjectByCode.get(data.subjectCode) : null;
      // 行已校验通过,理论上科目一定存在;防御性兜底。
      if (!subj) {
        throw new HTTPError(422, `第 ${row.rowNo} 行科目编码无效:${data.subjectCode}`);
      }
      const amount = normalizeAmount(data.amount);
      if (!amount) {
        throw new HTTPError(422, `第 ${row.rowNo} 行金额无效`);
      }
      const date = normalizeDate(data.businessDate);
      if (!date) {
        throw new HTTPError(422, `第 ${row.rowNo} 行业务日期无效`);
      }
      const statusEnum = data.businessStatus
        ? (STATUS_CN_TO_ENUM[data.businessStatus] as BusinessStatus | undefined)
        : undefined;
      if (!statusEnum) {
        throw new HTTPError(422, `第 ${row.rowNo} 行业务状态无效`);
      }

      const recordId = uuidv7();
      const created = await tx.businessRecord.create({
        data: {
          id: recordId,
          projectId: batch.projectId,
          budgetYear: Number(data.budgetYear),
          subjectId: subj.id,
          amount: toStored(fromStored(amount)),
          businessDate: new Date(`${date}T00:00:00Z`),
          handler: data.handler!,
          summary: data.summary!,
          status: statusEnum,
          remark: data.remark ?? null,
          isVoid: false,
          createdById: user.id,
        },
      });

      // §10.3 强制导入重复行留痕:置 forcedImport=true + 审计 after 附 forcedImport。
      if (row.duplicateFlag) {
        await tx.importRow.update({
          where: { id: row.id },
          data: { forcedImport: true },
        });
      }

      const after = snapshotRow({
        ...created,
        amount: created.amount.toFixed(2),
        businessDate: formatYmd(created.businessDate),
        importBatchId: batchId,
        importRowNo: row.rowNo,
        forcedImport: row.duplicateFlag,
      });

      await recordAudit(tx, {
        projectId: batch.projectId,
        objectType: 'business_records',
        objectId: recordId,
        action: 'import',
        operatorId: user.id,
        after,
      });

      createdIds.push(recordId);
    }

    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: 'confirmed', confirmedAt: now },
    });
  });

  return { created: createdIds.length, batchId };
}
