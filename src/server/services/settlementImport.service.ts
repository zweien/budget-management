import ExcelJS from 'exceljs';
import { BusinessStatus, Prisma, User } from '@prisma/client';

import { BULK_TX_OPTIONS, prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { toStored, fromStored } from '@/lib/decimal';
import { recordAudit } from '@/server/audit/interceptor';
import { snapshotRow } from '@/server/audit/snapshot';
import {
  SETTLEMENT_HEADERS,
  SETTLEMENT_HEADER_SCAN_ROWS,
  SETTLEMENT_SKIPPED_STATUS,
  SETTLEMENT_STATUS_TO_ENUM,
  SETTLEMENT_TEMPLATE_VERSION,
  SETTLEMENT_V2_APPLY_DATE,
} from '@/lib/excel/settlement';
import {
  cellToString,
  formatYmd,
  normalizeAmount,
  normalizeDate,
  type DuplicateLevel,
} from '@/server/services/excelImport.service';
import { checkDuplicates, hardDupReason } from '@/server/services/duplicateCheck.service';

/**
 * 个人结算单查询 Excel 导入(财务系统导出格式,与标准模板 §10 并存)。
 *
 * 差异点(相对 excelImport.service):
 * - 表头不在首行,按表头名匹配列;**两种版式并存**(见 src/lib/excel/settlement.ts):
 *   v1 填制日期版(填制日期/事项)与 v2 申请日期版(申请日期/完成日期/备注,其余新列忽略)。
 * - 无科目列:科目在预览页由用户逐条指定(updateSettlementRows 暂存),确认时写入。
 * - 单据状态映射:完成记账→PAID,制单保存/完成审核→FINANCE_APPROVAL,业务退单→跳过。
 * - 预算年度按日期(填制/申请)年份推导,预览页可改。
 * - **补全更新(refresh)**:docNo 命中项目内既有未作废记录且金额一致且带来新信息
 *   (新行有完成日期而已有记录缺 / 状态推进到已支出)→ 不判硬重复,确认后更新既有记录
 *   的 完成日期/状态(状态只前进);金额不一致或无新信息仍为硬重复(ADR 0002)。
 *
 * 复用 ImportBatch / ImportRow 两阶段流程:parse(status='pending') → 预览/暂存 → confirm。
 */

/** 结算单一行解析后的字段(ImportRow.parsedData)。 */
export interface SettlementParsedRow {
  kind: 'settlement';
  /** 财务系统单据编号(A 列;非必填)。 */
  docNo: string | null;
  /** 单据状态原文(完成记账/制单保存)。 */
  statusLabel: string;
  /** 映射后的业务状态。 */
  status: BusinessStatus;
  /** 申请日期(v2)/填制日期(v1),YYYY-MM-DD(解析失败时为原始文本,行会被标记 error)。 */
  businessDate: string;
  /** 完成日期 YYYY-MM-DD(仅 v2;可空/未记账为空)。 */
  completedDate?: string | null;
  /** 预算年度(默认=申请/填制日期年份;预览页可改)。 */
  budgetYear: number;
  /** 事项(J 列,富文本已拍平)。 */
  summary: string;
  /** 金额原始文本。 */
  amount: string;
  handler: string;
  /** 用户在预览页指定的科目(暂存持久化;确认时校验叶节点)。 */
  subjectId: string | null;
  subjectName: string | null;
  /** 硬重复理由(预览标记悬浮展示;非硬重复行为空)。 */
  dupReason?: string | null;
}

/** 单行字段级错误(与标准模板 RowFieldError 同形)。 */
export interface SettlementRowError {
  field: string;
  message: string;
}

/** 预览页一行。 */
export interface SettlementPreviewRow {
  rowId: string;
  rowNo: number;
  parsedData: SettlementParsedRow;
  validationStatus: 'valid' | 'error' | 'skipped';
  errors: SettlementRowError[];
  duplicateFlag: boolean;
  /** 重复档位:hard(单据编号硬重复,禁止确认)/ suspected(指纹疑似,可强制)。旧行 duplicateFlag=true → suspected。 */
  duplicateLevel: DuplicateLevel;
  forcedImport: boolean;
  /** 规范化金额(2 位小数字符串;错误行可能为 null)。 */
  normalizedAmount: string | null;
}

/** GET 预览返回:分组 + 该项目叶科目(供科目指定下拉)。 */
export interface SettlementBatchPreview {
  batchId: string;
  projectId: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  pending: SettlementPreviewRow[];
  duplicates: SettlementPreviewRow[];
  errors: SettlementPreviewRow[];
  /** 业务退单等被跳过的行数(仅提示条数)。 */
  skippedCount: number;
  /** 行被跳过的原因 → 条数(目前只有业务退单)。 */
  skippedReasons: Record<string, number>;
  /** 项目叶科目(科目指定下拉数据源)。 */
  leafSubjects: Array<{ id: string; code: string; name: string }>;
}

/** 批次列表项(上传页「进行中批次」/ 暂存再入口)。 */
export interface ImportBatchListItem {
  batchId: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  /** 文件包含的数据行数(含错误/重复/跳过行)。 */
  rowCount: number;
  /** 实际导入行数(确认时落定;未确认为 null)。 */
  createdCount: number | null;
  /** 补全更新行数(仅结算单 v2 场景;未确认为 null)。 */
  updatedCount: number | null;
}

/** 行更新入参(暂存:科目/年度/强制导入)。 */
export interface SettlementRowUpdate {
  rowId: string;
  /** null=清除已选科目。 */
  subjectId?: string | null;
  budgetYear?: number;
  forcedImport?: boolean;
}

/** 加载 workbook 并判断是否个人结算单格式;非本格式返回 null。 */
export async function loadSettlementWorkbookIfMatch(
  fileBuffer: ArrayBuffer | Buffer,
): Promise<ExcelJS.Workbook | null> {
  const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new HTTPError(422, '无法解析 Excel 文件:格式损坏或非 .xlsx');
  }
  for (const sheet of workbook.worksheets) {
    for (let r = 1; r <= Math.min(sheet.rowCount, SETTLEMENT_HEADER_SCAN_ROWS); r++) {
      const row = sheet.getRow(r);
      const headerVals = new Set<string>();
      row.eachCell({ includeEmpty: false }, (cell) => {
        const s = cellToString(cell);
        if (s) headerVals.add(s);
      });
      if (
        headerVals.has(SETTLEMENT_HEADERS.docNo) &&
        headerVals.has(SETTLEMENT_HEADERS.docStatus)
      ) {
        return workbook;
      }
    }
  }
  return null;
}

/**
 * 阶段一:解析 + 校验 + 疑似重复检测(个人结算单格式)。
 * - 权限:record:import + 项目范围。
 * - workbook 由调用方 loadSettlementWorkbookIfMatch 预载传入(避免重复解析)。
 * - 业务退单行以 validationStatus='skipped' 留痕(预览页仅提示条数)。
 * - 疑似重复:docNo 命中项目内既有未作废记录,或文件内重复出现同一 docNo;
 *   无 docNo 的行退回指纹(年度+金额+日期+摘要)比对既有记录。
 * - 不写业务记录;返回 batchId 供预览。
 */
export async function parseSettlement(
  workbook: ExcelJS.Workbook,
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
  fileName = 'upload.xlsx',
): Promise<string> {
  await requirePermission(user, 'record:import', projectId);

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new HTTPError(404, '项目不存在');
  }

  // 定位表头行(第一个同时含「单据编号」「单据状态」的行)。
  let headerRowNo = 0;
  let headerSheet: ExcelJS.Worksheet | null = null;
  const colIndex = new Map<string, number>();
  outer: for (const sheet of workbook.worksheets) {
    for (let r = 1; r <= Math.min(sheet.rowCount, SETTLEMENT_HEADER_SCAN_ROWS); r++) {
      const row = sheet.getRow(r);
      const found = new Map<string, number>();
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const s = cellToString(cell);
        if (s) found.set(s, colNumber);
      });
      if (found.has(SETTLEMENT_HEADERS.docNo) && found.has(SETTLEMENT_HEADERS.docStatus)) {
        headerRowNo = r;
        headerSheet = sheet;
        for (const key of Object.values(SETTLEMENT_HEADERS)) {
          const idx = found.get(key);
          if (idx) colIndex.set(key, idx);
        }
        break outer;
      }
    }
  }
  if (headerRowNo === 0 || !headerSheet) {
    throw new HTTPError(422, '未找到个人结算单表头(需包含 单据编号/单据状态)');
  }

  // 版式判定:表头含「申请日期」→ v2(申请日期版);否则为 v1(填制日期版)。两者长期并存。
  const isV2 = colIndex.has(SETTLEMENT_V2_APPLY_DATE);
  const requiredKeys = isV2
    ? [
        SETTLEMENT_HEADERS.docNo,
        SETTLEMENT_HEADERS.docStatus,
        SETTLEMENT_V2_APPLY_DATE,
        SETTLEMENT_HEADERS.amount,
        SETTLEMENT_HEADERS.handler,
        SETTLEMENT_HEADERS.remark,
      ]
    : [
        SETTLEMENT_HEADERS.docNo,
        SETTLEMENT_HEADERS.docStatus,
        SETTLEMENT_HEADERS.fillDate,
        SETTLEMENT_HEADERS.subject,
        SETTLEMENT_HEADERS.amount,
        SETTLEMENT_HEADERS.handler,
      ];
  // 必要列必须全部按表头名命中;缺列直接拒绝(静默回退到 A 列会把单据编号当成金额/经办人)。
  {
    const missing = requiredKeys.filter((k) => !colIndex.has(k));
    if (missing.length > 0) {
      throw new HTTPError(422, `结算单缺少必要列:${missing.join('、')},请核对导出文件`);
    }
  }
  const dateKey = isV2 ? SETTLEMENT_V2_APPLY_DATE : SETTLEMENT_HEADERS.fillDate;
  const summaryKey = isV2 ? SETTLEMENT_HEADERS.remark : SETTLEMENT_HEADERS.subject;
  const dateLabel = isV2 ? '申请日期' : '填制日期';

  const parsedRows: Array<{
    rowNo: number;
    data: SettlementParsedRow;
    errors: SettlementRowError[];
    validationStatus: 'valid' | 'error' | 'skipped';
    duplicate: boolean;
    duplicateLevel: DuplicateLevel;
  }> = [];

  // 表头所在工作表即数据区(而非固定取第一个 sheet)。
  const sheet = headerSheet;
  // 容量边界:行数上限(超大文件/zip 炸弹的 OOM 与事件循环阻塞防护)。
  if (sheet.rowCount - 1 - headerRowNo > env.MAX_IMPORT_ROWS) {
    throw new HTTPError(422, `数据行数超过上限 ${env.MAX_IMPORT_ROWS},请拆分文件后导入`);
  }
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNo) return;
    const get = (key: string): string | null => cellToString(row.getCell(colIndex.get(key) ?? 1));

    const docNo = get(SETTLEMENT_HEADERS.docNo);
    const statusLabel = get(SETTLEMENT_HEADERS.docStatus);
    const dateRaw = get(dateKey);
    const summary = get(summaryKey);
    const amountRaw = get(SETTLEMENT_HEADERS.amount);
    const handler = get(SETTLEMENT_HEADERS.handler);
    // v2:完成日期(可空列;v1 无此列)。
    const completedDateRaw =
      isV2 && colIndex.has(SETTLEMENT_HEADERS.completeDate)
        ? get(SETTLEMENT_HEADERS.completeDate)
        : null;

    // 空行(关键列全空)跳过。
    if (!docNo && !statusLabel && !dateRaw && !summary && !amountRaw && !handler) return;
    if (parsedRows.length >= env.MAX_IMPORT_ROWS) {
      throw new HTTPError(422, `数据行数超过上限 ${env.MAX_IMPORT_ROWS},请拆分文件后导入`);
    }

    // 业务退单:不导入,留痕跳过。
    if (statusLabel === SETTLEMENT_SKIPPED_STATUS) {
      parsedRows.push({
        rowNo: rowNumber,
        data: {
          kind: 'settlement',
          docNo,
          statusLabel,
          status: 'PAID',
          businessDate: dateRaw ?? '',
          completedDate: null,
          budgetYear: 0,
          summary: summary ?? '',
          amount: amountRaw ?? '',
          handler: handler ?? '',
          subjectId: null,
          subjectName: null,
        },
        errors: [{ field: 'docStatus', message: '业务退单,不导入' }],
        validationStatus: 'skipped',
        duplicate: false,
        duplicateLevel: 'none',
      });
      return;
    }

    const errors: SettlementRowError[] = [];

    const mapped = statusLabel ? SETTLEMENT_STATUS_TO_ENUM[statusLabel] : undefined;
    if (!mapped) {
      errors.push({
        field: 'docStatus',
        message: statusLabel
          ? `单据状态无法识别:${statusLabel}(支持 完成记账/制单保存/打印审签/完成审核,业务退单不导入)`
          : '单据状态不能为空',
      });
    }

    const date = normalizeDate(dateRaw);
    if (date === null) {
      errors.push({ field: 'fillDate', message: `${dateLabel}格式无效(应为 YYYY-MM-DD)` });
    }

    // v2 完成日期:可空;填了就必须是合法日期(与状态是否匹配不校验,Q7a 以状态为真相源)。
    let completedDate: string | null = null;
    if (completedDateRaw) {
      completedDate = normalizeDate(completedDateRaw);
      if (completedDate === null) {
        errors.push({ field: 'completedDate', message: '完成日期格式无效(应为 YYYY-MM-DD)' });
      } else if (date && completedDate < date) {
        // §codex P1:与手动/接口录入同规则——完成日期不得早于申请日期(否则导入会绕过
        // parseCompletedDate 校验,产出记录页不允许的日期对)。
        errors.push({
          field: 'completedDate',
          message: `完成日期(${completedDate})不能早于申请日期(${date})`,
        });
      }
    }

    const amount = normalizeAmount(amountRaw);
    if (amount === null) {
      errors.push({ field: 'amount', message: '金额必须为大于 0 的数字' });
    }

    if (!handler) {
      errors.push({ field: 'handler', message: '经办人不能为空' });
    }
    if (!summary) {
      errors.push({
        field: 'subject',
        message: isV2 ? '备注(摘要)不能为空' : '事项(摘要)不能为空',
      });
    }

    parsedRows.push({
      rowNo: rowNumber,
      data: {
        kind: 'settlement',
        docNo,
        statusLabel: statusLabel ?? '',
        status: (mapped ?? 'PAID') as BusinessStatus,
        businessDate: date ?? dateRaw ?? '',
        completedDate,
        budgetYear: date ? Number(date.slice(0, 4)) : 0,
        summary: summary ?? '',
        amount: amountRaw ?? '',
        handler: handler ?? '',
        subjectId: null,
        subjectName: null,
      },
      errors,
      validationStatus: errors.length === 0 ? 'valid' : 'error',
      duplicate: false,
      duplicateLevel: 'none',
    });
  });

  if (parsedRows.length === 0) {
    throw new HTTPError(422, 'Excel 文件不含任何有效数据行');
  }

  const validRows = parsedRows.filter((r) => r.validationStatus === 'valid');

  // ---- 重复检测(统一判定器 ADR 0002)----
  // docNo 命中未作废记录 / 批内同号 2+ → hard(禁止确认,不可强制);
  // 无编号行退回指纹(年度+金额+日期+摘要)→ suspected(可强制)。
  const verdicts = await checkDuplicates(
    projectId,
    validRows.map((r) => ({
      rowKey: String(r.rowNo),
      docNo: r.data.docNo,
      budgetYear: r.data.budgetYear > 0 ? r.data.budgetYear : null,
      amount: normalizeAmount(r.data.amount),
      businessDate: normalizeDate(r.data.businessDate),
      summary: r.data.summary || null,
      status: r.data.status,
      completedDate: r.data.completedDate ?? null,
    })),
    { allowRefresh: true },
  );
  const verdictByRowNo = new Map(verdicts.map((v) => [v.rowKey, v]));
  for (const r of validRows) {
    const v = verdictByRowNo.get(String(r.rowNo));
    if (!v) continue;
    if (v.hard) {
      r.duplicate = true;
      r.duplicateLevel = 'hard';
      r.data.dupReason = hardDupReason(v);
    } else if (v.refresh) {
      // §补全更新:同号命中但带来新信息,确认后更新既有记录(非新增)。
      r.duplicate = true;
      r.duplicateLevel = 'refresh';
    } else if (v.suspected) {
      r.duplicate = true;
      r.duplicateLevel = 'suspected';
    }
  }

  // ---- 落库 ----
  const batchId = uuidv7();
  await prisma.$transaction(async (tx) => {
    await tx.importBatch.create({
      data: {
        id: batchId,
        projectId,
        fileName,
        templateVersion: SETTLEMENT_TEMPLATE_VERSION,
        status: 'pending',
        creatorId: user.id,
      },
    });
    await tx.importRow.createMany({
      data: parsedRows.map((r) => ({
        id: uuidv7(),
        batchId,
        rowNo: r.rowNo,
        parsedData: r.data as unknown as Prisma.InputJsonValue,
        validationStatus: r.validationStatus,
        errors: (r.errors.length > 0 ? r.errors : null) as unknown as Prisma.InputJsonValue,
        duplicateFlag: r.duplicate,
        duplicateLevel: r.duplicateLevel,
        forcedImport: false,
      })),
    });
  }, BULK_TX_OPTIONS);

  return batchId;
}

// ---------- 预览 / 暂存 / 确认 ----------

/**
 * 预览页数据(个人结算单):分组 pending(含未指定科目的待处理行)/ duplicates /
 * errors / skipped,附项目叶科目(科目下拉数据源)。
 * - 权限:project:view + 项目范围。
 */
export async function getSettlementBatch(
  batchId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<SettlementBatchPreview> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowNo: 'asc' } } },
  });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'project:view', batch.projectId);
  if (batch.templateVersion !== SETTLEMENT_TEMPLATE_VERSION) {
    throw new HTTPError(409, '该批次不是个人结算单导入批次');
  }

  const toPreview = (r: (typeof batch.rows)[number]): SettlementPreviewRow => {
    const data = r.parsedData as unknown as SettlementParsedRow;
    const errs = (r.errors ?? null) as unknown as SettlementRowError[] | null;
    return {
      rowId: r.id,
      rowNo: r.rowNo,
      parsedData: data,
      validationStatus:
        r.validationStatus === 'valid' || r.validationStatus === 'skipped'
          ? r.validationStatus
          : 'error',
      errors: errs ?? [],
      duplicateFlag: r.duplicateFlag,
      // 旧行(0.10.x 前)只有 duplicateFlag:一律按疑似对待(保持可强制导入的历史行为)。
      duplicateLevel:
        r.duplicateLevel === 'hard' || r.duplicateLevel === 'refresh'
          ? r.duplicateLevel
          : r.duplicateFlag
            ? 'suspected'
            : 'none',
      forcedImport: r.forcedImport,
      normalizedAmount: normalizeAmount(data.amount),
    };
  };

  const pending: SettlementPreviewRow[] = [];
  const duplicates: SettlementPreviewRow[] = [];
  const errors: SettlementPreviewRow[] = [];
  const skippedReasons: Record<string, number> = {};
  let skippedCount = 0;
  for (const r of batch.rows) {
    const pr = toPreview(r);
    if (pr.validationStatus === 'skipped') {
      skippedCount += 1;
      const reason = pr.errors[0]?.message ?? '不导入';
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    } else if (pr.validationStatus === 'error') {
      errors.push(pr);
    } else if (pr.duplicateFlag) {
      duplicates.push(pr);
    } else {
      pending.push(pr);
    }
  }

  const leafSubjects = await prisma.budgetSubject.findMany({
    where: { projectId: batch.projectId, isLeaf: true },
    select: { id: true, code: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });

  return {
    batchId: batch.id,
    projectId: batch.projectId,
    fileName: batch.fileName,
    templateVersion: batch.templateVersion,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    confirmedAt: batch.confirmedAt ? batch.confirmedAt.toISOString() : null,
    pending,
    duplicates,
    errors,
    skippedCount,
    skippedReasons,
    leafSubjects,
  };
}

/**
 * 暂存:更新批次行的科目指定 / 预算年度 / 强制导入标记。
 * - 权限:record:import + 项目范围;仅 pending 批次可改。
 * - 科目必须为该项目叶节点;年度 1900~9999。
 * - 每次变更即时持久化,用户可离开后回来继续(导入页「进行中批次」再入口)。
 */
export async function updateSettlementRows(
  batchId: string,
  updates: SettlementRowUpdate[],
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: true },
  });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'record:import', batch.projectId);
  if (batch.templateVersion !== SETTLEMENT_TEMPLATE_VERSION) {
    throw new HTTPError(409, '该批次不是个人结算单导入批次');
  }
  if (batch.status !== 'pending') {
    throw new HTTPError(409, '该批次已确认,不可再修改');
  }

  const rowById = new Map(batch.rows.map((r) => [r.id, r]));

  // 预校验科目(同一批 updates 可能重复引用同一 subjectId)。
  const requestedSubjectIds = [
    ...new Set(
      updates
        .map((u) => u.subjectId)
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
    ),
  ];
  const subjectById = new Map<string, { id: string; name: string; isLeaf: boolean }>();
  if (requestedSubjectIds.length > 0) {
    const subjects = await prisma.budgetSubject.findMany({
      where: { projectId: batch.projectId, id: { in: requestedSubjectIds } },
      select: { id: true, name: true, isLeaf: true },
    });
    for (const s of subjects) subjectById.set(s.id, s);
  }

  await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      const row = rowById.get(u.rowId);
      if (!row) {
        throw new HTTPError(404, `导入行不存在:${u.rowId}`);
      }
      if (row.validationStatus !== 'valid') {
        throw new HTTPError(422, `第 ${row.rowNo} 行不是有效行,不可更新`);
      }
      const data = row.parsedData as unknown as SettlementParsedRow;

      if (u.subjectId !== undefined) {
        if (u.subjectId === null) {
          data.subjectId = null;
          data.subjectName = null;
        } else {
          const subj = subjectById.get(u.subjectId);
          if (!subj) {
            throw new HTTPError(422, `第 ${row.rowNo} 行科目不属于当前项目`);
          }
          if (!subj.isLeaf) {
            throw new HTTPError(422, `第 ${row.rowNo} 行科目不是叶节点,业务记录只能登记在叶科目`);
          }
          data.subjectId = subj.id;
          data.subjectName = subj.name;
        }
      }

      if (u.budgetYear !== undefined) {
        if (!Number.isInteger(u.budgetYear) || u.budgetYear < 1900 || u.budgetYear > 9999) {
          throw new HTTPError(422, `第 ${row.rowNo} 行预算年度必须是 1900~9999 的正整数`);
        }
        data.budgetYear = u.budgetYear;
      }

      // 硬重复(单据编号与未作废记录同号/批内同号)不可强制导入(codex 复审 P1 语义,ADR 0002)。
      // refresh 行不参与强制导入语义(确认即更新既有记录,非新增)。
      const level: DuplicateLevel =
        row.duplicateLevel === 'hard' || row.duplicateLevel === 'refresh'
          ? row.duplicateLevel
          : row.duplicateFlag
            ? 'suspected'
            : 'none';
      if (level === 'hard' && u.forcedImport === true) {
        throw new HTTPError(
          422,
          `第 ${row.rowNo} 行为硬重复(单据编号 ${data.docNo ?? '?'} 与未作废记录重复),不可强制导入;请先作废旧记录`,
        );
      }

      await tx.importRow.update({
        where: { id: row.id },
        data: {
          parsedData: data as unknown as Prisma.InputJsonValue,
          ...(u.forcedImport !== undefined ? { forcedImport: u.forcedImport } : {}),
        },
      });
    }
  }, BULK_TX_OPTIONS);
}

/**
 * 阶段二:确认入库(个人结算单)。
 * - 权限:record:import + 项目范围;仅 pending 批次。
 * - 新增行必须已指定叶科目;docNo 硬重复行必须 forcedImport=true;refresh 行不需要科目。
 * - 事务内复查:新增行的 docNo 冲突(解析后到确认前,他人可能已导入同单号)→ 422;
 *   refresh 行复核既有记录仍在且仍满足「金额一致 + 带来新信息」,否则 422。
 * - 新增行逐行写 business_record(含 docNo),审计 action='import';
 *   refresh 行更新既有记录的 完成日期/状态(状态只前进),审计 action='import_refresh'。
 *   batch → confirmed。
 */
export async function confirmSettlementImport(
  batchId: string,
  selectedRowIds: string[],
  user: Pick<User, 'id' | 'role'>,
): Promise<{ created: number; updated: number; batchId: string }> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: true },
  });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'record:import', batch.projectId);
  if (batch.templateVersion !== SETTLEMENT_TEMPLATE_VERSION) {
    throw new HTTPError(409, '该批次不是个人结算单导入批次');
  }
  if (batch.status !== 'pending') {
    throw new HTTPError(409, '该批次已确认,不可重复确认');
  }

  const selectedSet = new Set(selectedRowIds);
  const eligibleRows = batch.rows.filter(
    (r) => r.validationStatus === 'valid' && selectedSet.has(r.id),
  );
  if (eligibleRows.length === 0) {
    throw new HTTPError(422, '未选中任何可导入的行');
  }

  const subjectIds = new Set<string>();
  const levelOf = (r: (typeof batch.rows)[number]): DuplicateLevel =>
    r.duplicateLevel === 'hard' || r.duplicateLevel === 'refresh'
      ? r.duplicateLevel
      : r.duplicateFlag
        ? 'suspected'
        : 'none';
  const createRows: typeof eligibleRows = [];
  const refreshRows: typeof eligibleRows = [];
  for (const row of eligibleRows) {
    const data = row.parsedData as unknown as SettlementParsedRow;
    // 先判档位再查科目:硬重复/refresh 行与科目无关。
    if (levelOf(row) === 'refresh') {
      // §补全更新行:更新既有记录,不需要科目。
      if (!data.docNo) {
        throw new HTTPError(422, `第 ${row.rowNo} 行为补全更新行但缺少单据编号`);
      }
      refreshRows.push(row);
      continue;
    }
    if (levelOf(row) === 'hard') {
      throw new HTTPError(
        422,
        `第 ${row.rowNo} 行为硬重复(单据编号 ${data.docNo ?? '?'} 与未作废记录重复),不可导入;请先作废旧记录或取消勾选`,
      );
    }
    if (levelOf(row) === 'suspected' && !row.forcedImport) {
      throw new HTTPError(422, `第 ${row.rowNo} 行疑似重复,需勾选强制导入`);
    }
    if (!data.subjectId) {
      throw new HTTPError(422, `第 ${row.rowNo} 行尚未指定科目,不能导入`);
    }
    subjectIds.add(data.subjectId);
    createRows.push(row);
  }
  const subjects = await prisma.budgetSubject.findMany({
    where: { projectId: batch.projectId, id: { in: [...subjectIds] } },
    select: { id: true, isLeaf: true },
  });
  const leafIds = new Set(subjects.filter((s) => s.isLeaf).map((s) => s.id));
  for (const row of createRows) {
    const data = row.parsedData as unknown as SettlementParsedRow;
    if (!leafIds.has(data.subjectId!)) {
      throw new HTTPError(422, `第 ${row.rowNo} 行科目无效或不是叶节点`);
    }
  }

  const now = new Date();
  const createdIds: string[] = [];
  let updatedCount = 0;

  await prisma
    .$transaction(async (tx) => {
      // 原子占用批次,防并发重复确认。
      const claimed = await tx.importBatch.updateMany({
        where: { id: batchId, status: 'pending' },
        data: { status: 'confirming' },
      });
      if (claimed.count === 0) {
        throw new HTTPError(409, '该批次正在被确认或已确认,不可重复操作');
      }

      // docNo 兜底复查(解析到确认之间可能已有同单号入库)——仅新增行;refresh 行走下方复核。
      const checkDocNos = [
        ...new Set(
          createRows
            .map((r) => (r.parsedData as unknown as SettlementParsedRow).docNo)
            .filter((d): d is string => !!d),
        ),
      ];
      if (checkDocNos.length > 0) {
        const conflicts = await tx.businessRecord.findMany({
          where: { projectId: batch.projectId, isVoid: false, docNo: { in: checkDocNos } },
          select: { docNo: true },
        });
        if (conflicts.length > 0) {
          // 硬重复无强制通道(ADR 0002):同号已入库一律拒绝,无 forcedImport 豁免。
          const conflictSet = new Set(conflicts.map((c) => c.docNo));
          const badRows = createRows
            .filter((r) => {
              const d = (r.parsedData as unknown as SettlementParsedRow).docNo;
              return d && conflictSet.has(d);
            })
            .map((r) => r.rowNo);
          if (badRows.length > 0) {
            throw new HTTPError(
              422,
              `以下行的单据编号已被未作废记录占用(第 ${badRows.join('、')} 行),硬重复不可强制导入;请先作废旧记录`,
            );
          }
        }
      }

      // §补全更新:复核 + 更新既有记录(状态只前进不回退;完成日期以新行为准补缺)。
      for (const row of refreshRows) {
        const data = row.parsedData as unknown as SettlementParsedRow;
        const docNo = data.docNo!;
        // 行锁既有记录,与并发导入/编辑串行化。
        const existing = await tx.businessRecord.findFirst({
          where: { projectId: batch.projectId, isVoid: false, docNo },
        });
        const rowAmount = normalizeAmount(data.amount);
        if (!existing || !rowAmount || rowAmount !== existing.amount.toFixed(2)) {
          throw new HTTPError(
            422,
            `第 ${row.rowNo} 行的单据编号 ${docNo} 已不再满足补全更新条件(记录不存在、金额不一致或已作废),请刷新预览后重试`,
          );
        }
        const statusAdvances = data.status === 'PAID' && existing.status !== 'PAID';
        const fillsCompletion = !!data.completedDate && existing.completedDate === null;
        if (!statusAdvances && !fillsCompletion) {
          throw new HTTPError(
            422,
            `第 ${row.rowNo} 行的单据编号 ${docNo} 无可更新内容(完成日期已填或状态无需推进),该行已是硬重复;请刷新预览后重试`,
          );
        }
        // §codex P1:回填基准是**既有记录的申请日期**(行上的申请日期不回写)——
        // 完成日期早于既有申请日期时拒绝,与记录页录入规则一致。
        if (
          data.completedDate &&
          existing.businessDate &&
          new Date(`${data.completedDate}T00:00:00Z`) < existing.businessDate
        ) {
          throw new HTTPError(
            422,
            `第 ${row.rowNo} 行完成日期(${data.completedDate})早于该记录的申请日期(${formatYmd(
              existing.businessDate,
            )}),不可回填`,
          );
        }
        const snap = (rec: typeof existing) =>
          snapshotRow({
            ...rec,
            amount: rec.amount.toFixed(2),
            businessDate: formatYmd(rec.businessDate),
            completedDate: rec.completedDate ? formatYmd(rec.completedDate) : null,
          });
        const before = snap(existing);
        const updatedRecord = await tx.businessRecord.update({
          where: { id: existing.id },
          data: {
            ...(statusAdvances ? { status: 'PAID' as const } : {}),
            ...(data.completedDate
              ? { completedDate: new Date(`${data.completedDate}T00:00:00Z`) }
              : {}),
          },
        });
        // §codex P2:补全更新同步写业务记录历史(记录页「历史」只读 business_record_history)。
        await tx.businessRecordHistory.create({
          data: {
            id: uuidv7(),
            businessRecordId: existing.id,
            action: 'import_refresh',
            beforeData: before as unknown as Prisma.InputJsonValue,
            afterData: snap(updatedRecord) as unknown as Prisma.InputJsonValue,
            operatorId: user.id,
            reason: `结算单导入补全更新(批次 ${batchId} 第 ${row.rowNo} 行)`,
          },
        });
        await recordAudit(tx, {
          projectId: batch.projectId,
          objectType: 'business_records',
          objectId: existing.id,
          action: 'import_refresh',
          operatorId: user.id,
          before,
          after: snapshotRow({
            ...updatedRecord,
            completedDate: updatedRecord.completedDate
              ? formatYmd(updatedRecord.completedDate)
              : null,
            importBatchId: batchId,
            importRowNo: row.rowNo,
          }),
        });
      }

      for (const row of createRows) {
        const data = row.parsedData as unknown as SettlementParsedRow;
        const amount = normalizeAmount(data.amount);
        if (!amount) {
          throw new HTTPError(422, `第 ${row.rowNo} 行金额无效`);
        }
        const date = normalizeDate(data.businessDate);
        if (!date) {
          throw new HTTPError(422, `第 ${row.rowNo} 行填制日期无效`);
        }

        const recordId = uuidv7();
        const created = await tx.businessRecord.create({
          data: {
            id: recordId,
            projectId: batch.projectId,
            budgetYear: data.budgetYear,
            subjectId: data.subjectId!,
            amount: toStored(fromStored(amount)),
            businessDate: new Date(`${date}T00:00:00Z`),
            completedDate: data.completedDate ? new Date(`${data.completedDate}T00:00:00Z`) : null,
            handler: data.handler,
            summary: data.summary,
            status: data.status,
            docNo: data.docNo,
            isVoid: false,
            createdById: user.id,
          },
        });

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

      updatedCount = refreshRows.length;
      await tx.importBatch.update({
        where: { id: batchId },
        data: {
          status: 'confirmed',
          confirmedAt: now,
          createdCount: createdIds.length,
          updatedCount: refreshRows.length,
        },
      });
    }, BULK_TX_OPTIONS)
    .catch((e) => {
      // 并发窗口兜底(codex P2):同号行与他批并发确认 → 撞唯一索引 → 可读 422(硬重复无豁免)。
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new HTTPError(422, '单据编号已被并发导入占用;请刷新预览后重试(硬重复不可导入)');
      }
      throw e;
    });

  return { created: createdIds.length, updated: updatedCount, batchId };
}

/**
 * 批次列表(上传页「进行中批次」/ 暂存再入口)。
 * - 权限:project:view + 项目范围;最近 20 条。
 */
export async function listImportBatches(
  projectId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<ImportBatchListItem[]> {
  await requirePermission(user, 'project:view', projectId);
  const batches = await prisma.importBatch.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { _count: { select: { rows: true } } },
  });
  return batches.map((b) => ({
    batchId: b.id,
    fileName: b.fileName,
    templateVersion: b.templateVersion,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    confirmedAt: b.confirmedAt ? b.confirmedAt.toISOString() : null,
    rowCount: b._count.rows,
    createdCount: b.createdCount,
    updatedCount: b.updatedCount,
  }));
}

/**
 * 删除未导入批次(仅 pending;已确认批次是入账历史,不可删)。
 * - 权限:record:import + 项目范围。
 * - 事务内带 status='pending' 谓词条件删除批次(与并发确认原子互斥),再级联删行;
 *   抢不到即 409。审计 action='delete'。
 */
export async function deleteImportBatch(
  batchId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'record:import', batch.projectId);
  if (batch.status !== 'pending') {
    throw new HTTPError(409, '该批次已确认导入,不可删除');
  }

  await prisma.$transaction(async (tx) => {
    // §codex P1:条件删除原子兜底——解析后到删除前,并发确认可能已把批次置为
    // confirming/confirmed;带 status 谓词的 deleteMany 与确认的 updateMany 互斥,
    // 抢不到(pending)即 409 回滚,绝不误删已导入批次。先删行(外键),后条件删批次。
    await tx.importRow.deleteMany({ where: { batchId } });
    const deleted = await tx.importBatch.deleteMany({
      where: { id: batchId, status: 'pending' },
    });
    if (deleted.count === 0) {
      throw new HTTPError(409, '该批次已确认导入,不可删除');
    }
    await recordAudit(tx, {
      projectId: batch.projectId,
      objectType: 'import_batches',
      objectId: batchId,
      action: 'delete',
      operatorId: user.id,
      before: { fileName: batch.fileName, status: batch.status },
    });
  });
}
