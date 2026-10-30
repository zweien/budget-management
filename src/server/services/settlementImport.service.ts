import ExcelJS from 'exceljs';
import { BusinessStatus, Prisma, User } from '@prisma/client';

import { BULK_TX_OPTIONS, prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { denyApiKeyCrossProject, requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { toStored, fromStored } from '@/lib/decimal';
import { recordAudit } from '@/server/audit/interceptor';
import { createImportedRecords } from '@/server/services/importRecords.service';
import { snapshotRow } from '@/server/audit/snapshot';
import {
  isSettlementTemplateVersion,
  SETTLEMENT_HEADERS,
  SETTLEMENT_HEADER_SCAN_ROWS,
  SETTLEMENT_HEADERS_V3,
  SETTLEMENT_SKIPPED_STATUS,
  SETTLEMENT_STATUS_TO_ENUM,
  SETTLEMENT_TEMPLATE_VERSION,
  SETTLEMENT_V2_APPLY_DATE,
  SETTLEMENT_V3_MARKERS,
  SETTLEMENT_V3_TEMPLATE_VERSION,
} from '@/lib/excel/settlement';
import {
  cellToString,
  formatYmd,
  normalizeAmount,
  normalizeDate,
  type DuplicateLevel,
} from '@/server/services/excelImport.service';
import {
  checkDuplicates,
  hardDupReason,
  type DuplicateRowVerdict,
} from '@/server/services/duplicateCheck.service';

/**
 * 个人结算单查询 Excel 导入(财务系统导出格式,与标准模板 §10 并存)。
 *
 * 差异点(相对 excelImport.service):
 * - 表头不在首行,按表头名匹配列;**三种版式并存**(见 src/lib/excel/settlement.ts):
 *   v1 填制日期版(填制日期/事项)、v2 申请日期版(申请日期/完成日期/备注,其余新列忽略)、
 *   v3 2025 财务导出版(新增 科研项目名称/开支细项名称/预算科目代码/摘要 列;
 *   单据编号为明细行粒度,冲账重报产生同号多行 → 按单据编号分组、金额取组内代数和
 *   (净额)成一条记录;开支细项末段与本地叶科目名精确相等时自动预选科目)。
 * - 无科目列:科目在预览页由用户逐条指定(updateSettlementRows 暂存),确认时写入。
 * - 单据状态映射:完成记账→PAID;在途态(制单保存/打印审签/完成审核/待记账/完成复核/提交审核/完成收单)→FINANCE_APPROVAL;业务退单→跳过。
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
  /** 单据状态原文(完成记账/制单保存/待记账 等,见 SETTLEMENT_STATUS_TO_ENUM)。 */
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
  /** ---- v3 专属(明细分组合并版式) ---- */
  /** 开支细项层级路径全文(如「直接费用/会议、差旅、国际合作与交流/差旅费」)。 */
  detailPath?: string | null;
  /** 财务系统预算科目代码(与本地科目树编码无关,仅指派辅助)。 */
  finCode?: string | null;
  /** 文件「科研项目名称」原值(项目映射的键)。 */
  fileProjectName?: string | null;
  /** 目标项目(v3 项目映射结果;未映射为 null → 行不可确认)。 */
  targetProjectId?: string | null;
  /** 组内源行号(明细分组合并前的原始行)。 */
  sourceRows?: number[];
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
  /** 行被跳过的原因 → 条数(业务退单/纯冲账净额非正等)。 */
  skippedReasons: Record<string, number>;
  /** 项目名称。 */
  projectName: string | null;
  /** v3:各目标项目的叶科目(行级科目下拉按行目标项目取用;缺省回退 leafSubjects)。 */
  leafSubjectsByProject?: Record<string, Array<{ id: string; code: string; name: string }>>;
  /** 项目映射(v3):文件中每个 distinct 科研项目名称 → 当前映射的目标项目(未映射 null)。 */
  projectMappings: Array<{ fileProjectName: string; targetProjectId: string | null }>;
  /** 映射候选:当前用户有 record:import 的项目(ADMIN 全部;USER 为 OWNER/HANDLER 成员项目)。 */
  mappableProjects: Array<{ id: string; name: string }>;
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
  /** 目标项目(v3 项目映射;变更后服务端重跑科目预选与按目标查重)。 */
  targetProjectId?: string | null;
}

/** 扫描每表前 N 行,判断是否个人结算单格式(表头含 单据编号+单据状态)。 */
function detectSettlementFormat(workbook: ExcelJS.Workbook): boolean {
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
        return true;
      }
    }
  }
  return false;
}

/**
 * 加载 workbook 并识别格式(安全审计 bm1-imp:xlsx-decompress-preauthz-parse):
 * 探测与后续解析复用同一 workbook 对象——此前「探测 load 一遍 + 解析再 load 一遍」
 * 让标准模板文件被完整解压解析两次,双倍放大上传请求的内存/CPU 成本。
 */
export async function loadWorkbookWithFormatDetection(
  fileBuffer: ArrayBuffer | Buffer,
): Promise<{ workbook: ExcelJS.Workbook; isSettlement: boolean }> {
  const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new HTTPError(422, '无法解析 Excel 文件:格式损坏或非 .xlsx');
  }
  return { workbook, isSettlement: detectSettlementFormat(workbook) };
}

/** 加载 workbook 并判断是否个人结算单格式;非本格式返回 null。 */
export async function loadSettlementWorkbookIfMatch(
  fileBuffer: ArrayBuffer | Buffer,
): Promise<ExcelJS.Workbook | null> {
  const { workbook, isSettlement } = await loadWorkbookWithFormatDetection(fileBuffer);
  return isSettlement ? workbook : null;
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

  // v3(2025 财务导出)判定:表头同时含「科研项目名称」「开支细项名称」
  // → 明细分组合并版式(同号多行冲账重报,金额取组内代数和)。
  {
    const headerCells = new Set<string>();
    headerSheet.getRow(headerRowNo).eachCell({ includeEmpty: false }, (cell) => {
      const s = cellToString(cell);
      if (s) headerCells.add(s);
    });
    if (SETTLEMENT_V3_MARKERS.every((m) => headerCells.has(m))) {
      const { batchId } = await parseSettlementV3({
        sheet: headerSheet,
        headerRowNo,
        projectId,
        user,
        fileName,
      });
      return batchId;
    }
  }

  // 版式判定:表头含「申请日期」→ v2(申请日期版);否则为 v1(填制日期版)。两者长期并存。
  const templateVersion = SETTLEMENT_TEMPLATE_VERSION;
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
  // 容量边界(宽松早退):候选数据行粗计 rowCount-headerRowNo,只拦截约 2 倍明显超限
  // 的文件,精确封顶交给行内闸;文件内存占用的第一道闸是路由的 MAX_IMPORT_BYTES。
  if (sheet.rowCount - headerRowNo > env.MAX_IMPORT_ROWS * 2) {
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
    // 精确封顶:只计非空行(预闸的 rowCount 会含幽灵空行)。
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
          ? `单据状态无法识别:${statusLabel}(支持 完成记账/制单保存/打印审签/完成审核/待记账/完成复核/提交审核/完成收单,业务退单不导入)`
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

    // 预算年度 = 申请日期派生;与手动/标准模板导入同规则校验 1900~9999
    // (安全审计 bm1-imp:settlement-budgetyear-bypass:防 0001~1899 年度入库)。
    const budgetYear = date ? Number(date.slice(0, 4)) : 0;
    if (date && (budgetYear < 1900 || budgetYear > 9999)) {
      errors.push({
        field: 'budgetYear',
        message: `申请日期年度必须是 1900~9999 的正整数(当前 ${budgetYear})`,
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
        budgetYear,
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
        templateVersion,
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

/**
 * 上传者可导入(record:import)的项目候选:ADMIN=全部未归档;USER=OWNER/HANDLER 成员项目(未归档)。
 * 机器凭证(codex P2):selected 项目范围的 Key 只返回允许清单内的项目(与项目列表口径一致)。
 */
async function importableProjectsFor(
  user: Pick<User, 'id' | 'role'> & {
    viaApiKey?: boolean;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
): Promise<Array<{ id: string; name: string }>> {
  let list: Array<{ id: string; name: string }>;
  if (user.role === 'ADMIN') {
    list = await prisma.project.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  } else {
    const memberships = await prisma.projectMember.findMany({
      where: {
        userId: user.id,
        memberRole: { in: ['OWNER', 'HANDLER'] },
        project: { archivedAt: null },
      },
      select: { project: { select: { id: true, name: true } } },
    });
    list = memberships
      .map((m) => m.project)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }
  if (user.viaApiKey && (user.keyProjectScope ?? 'all') === 'selected') {
    const allow = new Set(user.keyProjectIds ?? []);
    list = list.filter((p) => allow.has(p.id));
  }
  return list;
}

/** 「科研项目名称」去财务口径前缀(首个「/」之前)后的可比对名称。 */
function stripProjectPrefix(fileProjectName: string): string {
  const i = fileProjectName.indexOf('/');
  return i >= 0 ? fileProjectName.slice(i + 1) : fileProjectName;
}

/** 目标项目的叶科目名 → 科目 id 映射(重名叶科目不入映射,预选歧义交人工)。 */
async function leafNameMapByProject(projectId: string): Promise<Map<string, string>> {
  const leaves = await prisma.budgetSubject.findMany({
    where: { projectId, isLeaf: true },
    select: { id: true, name: true },
  });
  const m = new Map<string, string>();
  for (const l of leaves) {
    if (m.has(l.name))
      m.set(l.name, ''); // 歧义标记
    else m.set(l.name, l.id);
  }
  for (const [name, id] of [...m]) {
    if (id === '') m.delete(name);
  }
  return m;
}

// ---------- v3(2025 财务导出):明细行按单据编号分组合并 ----------

/** 解析金额(允许负数:冲账行);空/非法返回 null。 */
function parseAmountAllowNegative(raw: string): Prisma.Decimal | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const d = new Prisma.Decimal(t);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

interface V3RawRow {
  rowNo: number;
  docNo: string;
  statusLabel: string;
  applyDate: string;
  completeDate: string;
  amountRaw: string;
  handler: string;
  summary: string;
  remark: string;
  detailPath: string;
  finCode: string;
  projectFileName: string;
}

/**
 * v3 版式解析:表头含 科研项目名称+开支细项名称(2025 财务导出)。
 *
 * 与 v1/v2 的差异:
 * - 单据编号是明细行粒度,冲账重报会产生同号多行(含负数行)→ 按单据编号分组,
 *   金额取组内代数和(净额)成一条记录;净额 ≤ 0 的组(纯冲账)整组跳过留痕;
 *   组内 经办人/开支细项 不一致 → error 交人工。
 * - 摘要取「摘要」列,空则退「备注」,组内取第一个非空。
 * - 科目自动预选:开支细项末段与本地叶科目名精确相等(且不重名)时预选;
 *   否则留空走预览指派/摘要历史映射。
 * - 「科研项目名称」驱动项目映射(自动预映射:去前缀后包含唯一候选项目名;未命中人工映射)。
 */
async function parseSettlementV3(opts: {
  sheet: ExcelJS.Worksheet;
  headerRowNo: number;
  projectId: string;
  user: Pick<User, 'id' | 'role'> & {
    viaApiKey?: boolean;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  };
  fileName: string;
  /** 统一入口:强制批次承载项目(缺省回退上传项目上下文)。 */
  batchProjectId?: string;
}): Promise<{ batchId: string; batchProjectId: string }> {
  const { sheet, headerRowNo, projectId, user, fileName } = opts;

  const colIndex = new Map<string, number>();
  sheet.getRow(headerRowNo).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const s = cellToString(cell);
    if (s) colIndex.set(s, colNumber);
  });
  const required = [
    SETTLEMENT_HEADERS.docNo,
    SETTLEMENT_HEADERS.docStatus,
    SETTLEMENT_V2_APPLY_DATE,
    SETTLEMENT_HEADERS.amount,
    SETTLEMENT_HEADERS.handler,
    ...SETTLEMENT_V3_MARKERS,
  ];
  const missing = required.filter((k) => !colIndex.has(k));
  if (missing.length > 0) {
    throw new HTTPError(422, `结算单缺少必要列:${missing.join('、')},请核对导出文件`);
  }
  const get = (row: ExcelJS.Row, key: string): string => {
    const idx = colIndex.get(key);
    return idx === undefined ? '' : (cellToString(row.getCell(idx)) ?? '').trim();
  };

  // 收集原始明细行(空行跳过;容量闸与 v1/v2 同规则)。
  const rawRows: V3RawRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNo) return;
    const docNo = get(row, SETTLEMENT_HEADERS.docNo);
    const statusLabel = get(row, SETTLEMENT_HEADERS.docStatus);
    const applyDate = get(row, SETTLEMENT_V2_APPLY_DATE);
    const amountRaw = get(row, SETTLEMENT_HEADERS.amount);
    const handler = get(row, SETTLEMENT_HEADERS.handler);
    if (!docNo && !statusLabel && !applyDate && !amountRaw && !handler) return;
    if (rawRows.length >= env.MAX_IMPORT_ROWS) {
      throw new HTTPError(422, `数据行数超过上限 ${env.MAX_IMPORT_ROWS},请拆分文件后导入`);
    }
    rawRows.push({
      rowNo: rowNumber,
      docNo,
      statusLabel,
      applyDate,
      completeDate: get(row, SETTLEMENT_HEADERS.completeDate),
      amountRaw,
      handler,
      summary: get(row, SETTLEMENT_HEADERS_V3.summary),
      remark: get(row, SETTLEMENT_HEADERS.remark),
      detailPath: get(row, SETTLEMENT_HEADERS_V3.detailPath),
      finCode: get(row, SETTLEMENT_HEADERS_V3.finCode),
      projectFileName: get(row, SETTLEMENT_HEADERS_V3.projectName),
    });
  });

  // 项目映射(v3):distinct 科研项目名称 → 目标项目。
  // 自动预映射:去口径前缀后包含唯一可导入项目名 → 自动落;未命中/多命中 → null(人工)。
  const candidates = await importableProjectsFor(user);
  const mappingByName = new Map<string, string | null>();
  for (const name of new Set(rawRows.map((r) => r.projectFileName).filter(Boolean))) {
    const stripped = stripProjectPrefix(name);
    const hits = candidates.filter((c) => stripped.includes(c.name));
    mappingByName.set(name, hits.length === 1 ? hits[0].id : null);
  }
  const targetIds = [...new Set([...mappingByName.values()].filter((v): v is string => !!v))];
  const leafNameByTarget = new Map<string, Map<string, string>>();
  for (const tid of targetIds) {
    leafNameByTarget.set(tid, await leafNameMapByProject(tid));
  }

  const parsedRows: Array<{
    rowNo: number;
    data: SettlementParsedRow;
    errors: SettlementRowError[];
    validationStatus: 'valid' | 'error' | 'skipped';
    duplicate: boolean;
    duplicateLevel: DuplicateLevel;
  }> = [];

  // 业务退单:整行跳过留痕,不参与分组。
  for (const r of rawRows) {
    if (r.statusLabel !== SETTLEMENT_SKIPPED_STATUS) continue;
    parsedRows.push({
      rowNo: r.rowNo,
      data: {
        kind: 'settlement',
        docNo: r.docNo || null,
        statusLabel: r.statusLabel,
        status: 'PAID',
        businessDate: r.applyDate,
        completedDate: null,
        budgetYear: 0,
        summary: r.summary || r.remark,
        amount: r.amountRaw,
        handler: r.handler,
        subjectId: null,
        subjectName: null,
      },
      errors: [{ field: 'docStatus', message: '业务退单,不导入' }],
      validationStatus: 'skipped',
      duplicate: false,
      duplicateLevel: 'none',
    });
  }

  // 按单据编号+科研项目名称分组(codex P1:同一单据可能拆到不同项目,
  // 跨项目的同号行不得合并,金额须按各自项目分别结算);空编号行各自成组。
  const groups = new Map<string, V3RawRow[]>();
  for (const r of rawRows) {
    if (r.statusLabel === SETTLEMENT_SKIPPED_STATUS) continue;
    const key = `${r.docNo || `__row_${r.rowNo}`}__${r.projectFileName}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  for (const grp of groups.values()) {
    const rowNo = grp[0].rowNo;
    const errors: SettlementRowError[] = [];
    const first = grp[0];

    // 状态:组内取首行;无法映射 → error。
    const statusLabel = first.statusLabel;
    const mapped = statusLabel ? SETTLEMENT_STATUS_TO_ENUM[statusLabel] : undefined;
    if (!mapped) {
      errors.push({
        field: 'docStatus',
        message: statusLabel
          ? `单据状态无法识别:${statusLabel}(支持 完成记账/制单保存/打印审签/完成审核/待记账/完成复核/提交审核/完成收单,业务退单不导入)`
          : '单据状态不能为空',
      });
    }

    // 经办人/开支细项:组内不一致 → 人工核对。
    const distinctHandlers = [...new Set(grp.map((r) => r.handler).filter(Boolean))];
    if (distinctHandlers.length > 1) {
      errors.push({
        field: 'handler',
        message: `组内经办人不一致(${distinctHandlers.join('/')}),请回财务核对`,
      });
    }
    const handler = distinctHandlers[0] ?? '';
    if (!handler) errors.push({ field: 'handler', message: '经办人不能为空' });

    const detailPaths = [...new Set(grp.map((r) => r.detailPath).filter(Boolean))];
    if (detailPaths.length > 1) {
      errors.push({
        field: 'subject',
        message: `组内开支细项不一致(${detailPaths.length} 种),请回财务核对或拆分导入`,
      });
    }
    const detailPath = detailPaths[0] ?? '';
    const detailLeaf = detailPath ? (detailPath.split('/').pop() ?? '').trim() : '';
    const finCode = grp.map((r) => r.finCode).find(Boolean) ?? '';
    const fileProjectName = grp.map((r) => r.projectFileName).find(Boolean) ?? '';

    // 金额:组内代数和(负数行 = 冲账,互相抵销);任一行无法解析 → 整组标错。
    let net: Prisma.Decimal | null = null;
    for (const r of grp) {
      const d = parseAmountAllowNegative(r.amountRaw);
      if (d === null) {
        errors.push({ field: 'amount', message: `金额无法解析:${r.amountRaw || '(空)'}` });
        net = null;
        break;
      }
      net = net === null ? d : net.plus(d);
    }
    const netStr = net === null ? null : net.toFixed(2);
    if (net !== null && netStr !== null && net.lessThanOrEqualTo(0)) {
      // 纯冲账/净额非正:整组跳过留痕(不阻断其它组)。
      parsedRows.push({
        rowNo,
        data: {
          kind: 'settlement',
          docNo: first.docNo || null,
          statusLabel: statusLabel ?? '',
          status: (mapped ?? 'PAID') as BusinessStatus,
          businessDate: first.applyDate,
          completedDate: null,
          budgetYear: 0,
          summary: first.summary || first.remark,
          amount: netStr,
          handler,
          subjectId: null,
          subjectName: null,
          detailPath: detailPath || null,
          finCode: finCode || null,
          fileProjectName: fileProjectName || null,
          sourceRows: grp.map((r) => r.rowNo),
        },
        errors: [{ field: 'amount', message: `单据净额 ${netStr} ≤ 0(冲账单据),不导入` }],
        validationStatus: 'skipped',
        duplicate: false,
        duplicateLevel: 'none',
      });
      continue;
    }

    // 日期:申请日期组内取最晚;完成日期取最晚非空;完成不得早于申请。
    let businessDate = '';
    const applyParsed: string[] = [];
    for (const r of grp) {
      if (!r.applyDate) continue;
      const d = normalizeDate(r.applyDate);
      if (d === null) {
        errors.push({ field: 'fillDate', message: `申请日期格式无效:${r.applyDate}` });
        applyParsed.length = 0;
        break;
      }
      applyParsed.push(d);
    }
    if (applyParsed.length > 0) {
      businessDate = [...applyParsed].sort().pop()!;
    } else if (!errors.some((e) => e.field === 'fillDate')) {
      // 整组无申请日期:不标 error 的话确认期才失败且预览无法修复(codex P2)。
      errors.push({ field: 'fillDate', message: '申请日期不能为空' });
    }
    let completedDate: string | null = null;
    const completeParsed: string[] = [];
    for (const r of grp) {
      if (!r.completeDate) continue;
      const d = normalizeDate(r.completeDate);
      if (d === null) {
        errors.push({ field: 'completedDate', message: `完成日期格式无效:${r.completeDate}` });
        completeParsed.length = 0;
        break;
      }
      completeParsed.push(d);
    }
    if (completeParsed.length > 0) {
      completedDate = [...completeParsed].sort().pop()!;
      if (businessDate && completedDate < businessDate) {
        errors.push({
          field: 'completedDate',
          message: `完成日期(${completedDate})不能早于申请日期(${businessDate})`,
        });
      }
    }

    // 预算年度 = 申请日期年份。
    const budgetYear = businessDate ? Number(businessDate.slice(0, 4)) : 0;
    if (businessDate && (budgetYear < 1900 || budgetYear > 9999)) {
      errors.push({
        field: 'budgetYear',
        message: `申请日期年度必须是 1900~9999 的正整数(当前 ${budgetYear})`,
      });
    }

    // 摘要:摘要列优先,备注兜底,组内取第一个非空;
    // 两者皆空允许(裁决 Q3:按单据编号/指纹查重兜底,不报错)。
    const summary =
      grp.map((r) => r.summary).find(Boolean) ?? grp.map((r) => r.remark).find(Boolean) ?? '';

    // 项目映射:自动预映射结果;未映射 → error(不可确认,预览页映射后恢复)。
    const targetProjectId = mappingByName.get(first.projectFileName) ?? null;
    if (!targetProjectId) {
      errors.push({ field: 'project', message: '未映射项目;请在「项目映射」区选择目标项目' });
    }
    // 科目自动预选:开支细项末段 == 目标项目唯一叶科目名。
    const preselected =
      targetProjectId && detailLeaf
        ? (leafNameByTarget.get(targetProjectId)?.get(detailLeaf) ?? null)
        : null;

    const data: SettlementParsedRow = {
      kind: 'settlement',
      docNo: first.docNo || null,
      statusLabel: statusLabel ?? '',
      status: (mapped ?? 'PAID') as BusinessStatus,
      businessDate,
      completedDate,
      budgetYear,
      summary,
      amount: netStr ?? first.amountRaw,
      handler,
      subjectId: preselected,
      subjectName: preselected ? detailLeaf : null,
      targetProjectId,
      detailPath: detailPath || null,
      finCode: finCode || null,
      fileProjectName: fileProjectName || null,
      sourceRows: grp.map((r) => r.rowNo),
    };
    parsedRows.push({
      rowNo,
      data,
      errors,
      validationStatus: errors.length === 0 ? 'valid' : 'error',
      duplicate: false,
      duplicateLevel: 'none',
    });
  }

  if (parsedRows.length === 0) {
    throw new HTTPError(422, 'Excel 文件不含任何有效数据行');
  }

  const validRows = parsedRows.filter((r) => r.validationStatus === 'valid');

  // ---- 重复检测:按行目标项目分组跑统一判定器 ADR 0002(金额为组内净额)----
  const applyVerdict = (r: (typeof validRows)[number], v: DuplicateRowVerdict): void => {
    if (v.hard) {
      r.duplicate = true;
      r.duplicateLevel = 'hard';
      r.data.dupReason = hardDupReason(v);
    } else if (v.refresh) {
      r.duplicate = true;
      r.duplicateLevel = 'refresh';
    } else if (v.suspected) {
      r.duplicate = true;
      r.duplicateLevel = 'suspected';
    }
  };
  const rowsByTarget = new Map<string, typeof validRows>();
  for (const r of validRows) {
    const t = r.data.targetProjectId!;
    const g = rowsByTarget.get(t);
    if (g) g.push(r);
    else rowsByTarget.set(t, [r]);
  }
  for (const [target, rows] of rowsByTarget) {
    const verdicts = await checkDuplicates(
      target,
      rows.map((r) => ({
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
    for (const r of rows) {
      const v = verdictByRowNo.get(String(r.rowNo));
      if (v) applyVerdict(r, v);
    }
  }

  // ---- 落库 ----
  // 批次承载项目:统一入口的强制承载 > 上传项目上下文(容器语义,行入账按行级映射)。
  const batchProjectId = opts.batchProjectId ?? projectId;
  const batchId = uuidv7();
  await prisma.$transaction(async (tx) => {
    await tx.importBatch.create({
      data: {
        id: batchId,
        projectId: batchProjectId,
        fileName,
        templateVersion: SETTLEMENT_V3_TEMPLATE_VERSION,
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

  return { batchId, batchProjectId };
}

/**
 * 统一导入入口(v3 财务结算单):不依赖项目上下文解析文件。
 * - 批次承载项目 = hostProjectId(显式指定) > 自动预映射的第一个目标项目;
 *   两者皆无 → 422 needsHost(调用方让用户选择承载项目后携 hostProjectId 重传)。
 * - 仅接受 v3 版式;v1/v2/标准模板请在项目内导入。
 * - 承载项目显式指定时要求 record:import(自动命中目标项目不在此校验,
 *   映射暂存与确认会逐目标项目复核)。
 */
export async function parseSettlementUnified(
  fileBuffer: ArrayBuffer | Buffer,
  user: Pick<User, 'id' | 'role'> & {
    viaApiKey?: boolean;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
  fileName = 'upload.xlsx',
  hostProjectId?: string,
): Promise<{
  batchId: string | null;
  batchProjectId: string | null;
  needsHost: boolean;
  mappableProjects?: Array<{ id: string; name: string }>;
}> {
  // selected 项目范围凭证:跨项目/无项目上下文接口一律 403(审计后拒绝,codex P1)。
  await denyApiKeyCrossProject(user, 'record:import');

  const { workbook, isSettlement } = await loadWorkbookWithFormatDetection(fileBuffer);
  if (!isSettlement) {
    throw new HTTPError(422, '仅支持财务结算单(2025 导出)格式;系统模板/个人结算单请在项目内导入');
  }

  // v3 版式判定(与项目内入口同一规则)。
  let headerRowNo = 0;
  let headerSheet: ExcelJS.Worksheet | null = null;
  const headerCells = new Set<string>();
  outer: for (const sheet of workbook.worksheets) {
    for (let r = 1; r <= Math.min(sheet.rowCount, SETTLEMENT_HEADER_SCAN_ROWS); r++) {
      const row = sheet.getRow(r);
      const found = new Set<string>();
      row.eachCell({ includeEmpty: false }, (cell) => {
        const s = cellToString(cell);
        if (s) found.add(s);
      });
      if (found.has(SETTLEMENT_HEADERS.docNo) && found.has(SETTLEMENT_HEADERS.docStatus)) {
        headerRowNo = r;
        headerSheet = sheet;
        headerCells.clear();
        found.forEach((v) => headerCells.add(v));
        break outer;
      }
    }
  }
  if (headerRowNo === 0 || !headerSheet) {
    throw new HTTPError(422, '未找到结算单表头(需包含 单据编号/单据状态)');
  }
  const isV3 = SETTLEMENT_V3_MARKERS.every((m) => headerCells.has(m));
  if (!isV3) {
    throw new HTTPError(422, '仅支持财务结算单(2025 导出)格式;个人结算单查询请在项目内导入');
  }

  // 显式承载项目:须存在、未归档、可导入。
  if (hostProjectId) {
    const host = await prisma.project.findUnique({
      where: { id: hostProjectId },
      select: { archivedAt: true },
    });
    if (!host) throw new HTTPError(404, '承载项目不存在');
    if (host.archivedAt) throw new HTTPError(422, '承载项目已归档,数据只读');
    await requirePermission(user, 'record:import', hostProjectId);
  }

  // 先探测自动预映射(轻量:解析前只读科研列 + 候选匹配)——无命中且未显式指定 → needsHost。
  // 实现为「解析后落库前判定」:解析本身只读,无副作用,直接复用 v3 解析并捕获无主结果。
  if (!hostProjectId) {
    const probe = await probeV3FirstTarget(headerSheet, headerRowNo, user);
    if (!probe) {
      // 显式空批次结果 + needsHost 标记:调用方让用户选择承载项目后携 hostProjectId 重传。
      return {
        batchId: null,
        batchProjectId: null,
        needsHost: true,
        mappableProjects: await importableProjectsFor(user),
      };
    }
    // 自动命中也要过 record:import(codex P1:只读凭证不得借自动映射创建批次)。
    await requirePermission(user, 'record:import', probe);
    hostProjectId = probe;
  }

  const { batchId, batchProjectId } = await parseSettlementV3({
    sheet: headerSheet,
    headerRowNo,
    projectId: hostProjectId,
    user,
    fileName,
    batchProjectId: hostProjectId,
  });
  return { batchId, batchProjectId, needsHost: false, mappableProjects: undefined };
}

/** 探测 v3 文件的自动预映射第一个目标项目;无命中返回 null(不落任何数据)。 */
async function probeV3FirstTarget(
  sheet: ExcelJS.Worksheet,
  headerRowNo: number,
  user: Pick<User, 'id' | 'role'> & {
    viaApiKey?: boolean;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
): Promise<string | null> {
  const colIndex = new Map<string, number>();
  sheet.getRow(headerRowNo).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const s = cellToString(cell);
    if (s) colIndex.set(s, colNumber);
  });
  const nameCol = colIndex.get(SETTLEMENT_HEADERS_V3.projectName);
  if (!nameCol) return null;
  const names = new Set<string>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNo) return;
    const idx = colIndex.get(SETTLEMENT_HEADERS_V3.projectName);
    const v = idx ? cellToString(row.getCell(idx)) : null;
    if (v && v.trim()) names.add(v.trim());
  });
  const candidates = await importableProjectsFor(user);
  for (const name of names) {
    const stripped = stripProjectPrefix(name);
    const hits = candidates.filter((c) => stripped.includes(c.name));
    if (hits.length === 1) return hits[0].id;
  }
  return null;
}

/**
 * 我的结算单批次(统一导入入口「进行中批次」列表):
 * 当前用户创建的 settlement 批次(含已确认,便于核对),最近 20 条。
 * - 权限:仅本人批次(creatorId=当前用户),无需项目上下文。
 */
export async function listMySettlementBatches(
  user: Pick<User, 'id' | 'role'> & {
    viaApiKey?: boolean;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
): Promise<
  Array<{
    batchId: string;
    hostProjectId: string;
    hostProjectName: string;
    fileName: string;
    templateVersion: string;
    status: string;
    createdAt: string;
    rowCount: number;
  }>
> {
  // selected 项目范围凭证:无项目上下文的聚合列表一律 403(审计后拒绝,codex P1)。
  await denyApiKeyCrossProject(user, 'record:import');

  const batches = await prisma.importBatch.findMany({
    where: {
      creatorId: user.id,
      templateVersion: { in: [SETTLEMENT_TEMPLATE_VERSION, SETTLEMENT_V3_TEMPLATE_VERSION] },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      projectId: true,
      fileName: true,
      templateVersion: true,
      status: true,
      createdAt: true,
      _count: { select: { rows: true } },
      project: { select: { name: true } },
    },
  });
  return batches.map((b) => ({
    batchId: b.id,
    hostProjectId: b.projectId,
    hostProjectName: b.project.name,
    fileName: b.fileName,
    templateVersion: b.templateVersion,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    rowCount: b._count.rows,
  }));
}

// ---------- 预览 / 暂存 / 确认 ----------

/**
 * 预览页数据(个人结算单):分组 pending(含未指定科目的待处理行)/ duplicates /
 * errors / skipped,附项目叶科目(科目下拉数据源)。
 * - 权限:project:view + 项目范围。
 */
export async function getSettlementBatch(
  batchId: string,
  user: Pick<User, 'id' | 'role'> & {
    viaApiKey?: boolean;
    keyProjectScope?: string;
    keyProjectIds?: string[];
  },
): Promise<SettlementBatchPreview> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowNo: 'asc' } } },
  });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'project:view', batch.projectId);
  if (!isSettlementTemplateVersion(batch.templateVersion)) {
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

  const [leafSubjects, project] = await Promise.all([
    prisma.budgetSubject.findMany({
      where: { projectId: batch.projectId, isLeaf: true },
      select: { id: true, code: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    }),
    prisma.project.findUnique({
      where: { id: batch.projectId },
      select: { name: true },
    }),
  ]);

  // 项目映射(v3):按行数据归纳 distinct 科研项目名称(顺序=行序)。
  const projectMappings = new Map<string, string | null>();
  const rowTargets = new Set<string>([batch.projectId]);
  for (const r of [...pending, ...duplicates, ...errors]) {
    const d = r.parsedData as SettlementParsedRow;
    if (d.fileProjectName && !projectMappings.has(d.fileProjectName)) {
      projectMappings.set(d.fileProjectName, d.targetProjectId ?? null);
    }
    if (d.targetProjectId) rowTargets.add(d.targetProjectId);
  }
  // v3:各目标项目的叶科目(行级下拉按行目标取用;v1/v2 仅批次项目)。
  const leafSubjectsByProject: Record<
    string,
    Array<{ id: string; code: string; name: string }>
  > = {};
  if (batch.templateVersion === SETTLEMENT_V3_TEMPLATE_VERSION) {
    await Promise.all(
      [...rowTargets].map(async (pid) => {
        leafSubjectsByProject[pid] = await prisma.budgetSubject.findMany({
          where: { projectId: pid, isLeaf: true },
          select: { id: true, code: true, name: true },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        });
      }),
    );
  }

  return {
    batchId: batch.id,
    projectId: batch.projectId,
    fileName: batch.fileName,
    projectName: project?.name ?? null,
    projectMappings: [...projectMappings].map(([fileProjectName, targetProjectId]) => ({
      fileProjectName,
      targetProjectId,
    })),
    mappableProjects: isSettlementTemplateVersion(batch.templateVersion)
      ? await importableProjectsFor(user)
      : [],
    leafSubjectsByProject,
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
  if (!isSettlementTemplateVersion(batch.templateVersion)) {
    throw new HTTPError(409, '该批次不是个人结算单导入批次');
  }
  if (batch.status !== 'pending') {
    throw new HTTPError(409, '该批次已确认,不可再修改');
  }
  const isV3 = batch.templateVersion === SETTLEMENT_V3_TEMPLATE_VERSION;
  for (const u of updates) {
    if (u.targetProjectId !== undefined && !isV3) {
      throw new HTTPError(422, '仅财务结算单(2025 导出)支持项目映射');
    }
  }

  const rowById = new Map(batch.rows.map((r) => [r.id, r]));
  for (const u of updates) {
    if (!rowById.has(u.rowId)) {
      throw new HTTPError(404, `导入行不存在:${u.rowId}`);
    }
  }

  // 目标项目映射(v3):先逐目标校验导入权限(一次失败整批拒绝,UI 候选已限定)。
  const targetProjects = [
    ...new Set(
      updates
        .map((u) => u.targetProjectId)
        .filter((t): t is string => typeof t === 'string' && t.length > 0),
    ),
  ];
  for (const t of targetProjects) {
    const project = await prisma.project.findUnique({
      where: { id: t },
      select: { archivedAt: true },
    });
    if (!project) throw new HTTPError(422, `映射的目标项目不存在:${t}`);
    if (project.archivedAt) throw new HTTPError(422, '映射的目标项目已归档,数据只读');
    await requirePermission(user, 'record:import', t);
  }

  // 科目校验池:按 (项目, 科目id) 惰性缓存——v3 行科目须属于其目标项目。
  const subjectPoolKey = (projectId: string, subjectId: string) => `${projectId}:${subjectId}`;
  const subjectPool = new Map<string, { id: string; name: string; isLeaf: boolean }>();
  const getSubject = async (projectId: string, subjectId: string) => {
    const key = subjectPoolKey(projectId, subjectId);
    const hit = subjectPool.get(key);
    if (hit) return hit;
    const subj = await prisma.budgetSubject.findFirst({
      where: { projectId, id: subjectId },
      select: { id: true, name: true, isLeaf: true },
    });
    if (subj) subjectPool.set(key, subj);
    return subj ?? null;
  };

  // v3 目标变更行的重算(预选 + 查重)集中按目标分组执行。
  interface RemapJob {
    row: (typeof batch.rows)[number];
    data: SettlementParsedRow;
    target: string;
    baseErrors: SettlementRowError[];
    nextErrors: SettlementRowError[] | null;
  }
  const remapJobs: RemapJob[] = [];

  await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      const row = rowById.get(u.rowId)!;
      const data = row.parsedData as unknown as SettlementParsedRow;
      const rowProjectId = data.targetProjectId ?? batch.projectId;

      // 项目映射(v3):允许作用于任意校验态的行(未映射行本身是 error 态)。
      if (u.targetProjectId !== undefined) {
        const target = u.targetProjectId && u.targetProjectId.length > 0 ? u.targetProjectId : null;
        if (target === null) {
          data.targetProjectId = null;
          data.subjectId = null;
          data.subjectName = null;
          const kept = ((row.errors ?? null) as SettlementRowError[] | null) ?? [];
          const nextErrors: SettlementRowError[] = [
            ...kept.filter((e) => e.field !== 'project'),
            { field: 'project', message: '未映射项目;请在「项目映射」区选择目标项目' },
          ];
          await tx.importRow.update({
            where: { id: row.id },
            data: {
              parsedData: data as unknown as Prisma.InputJsonValue,
              errors: nextErrors as unknown as Prisma.InputJsonValue,
              validationStatus: 'error',
              duplicateFlag: false,
              duplicateLevel: 'none',
            },
          });
          continue;
        }
        data.targetProjectId = target;
        // 重算基准 = 既有错误去掉「未映射项目」(本次映射即消除它);其余真实错误保留。
        const baseErrors = (((row.errors ?? null) as SettlementRowError[] | null) ?? []).filter(
          (e) => e.field !== 'project',
        );
        remapJobs.push({
          row,
          data,
          target,
          baseErrors,
          nextErrors: baseErrors.length > 0 ? baseErrors : null,
        });
        // 重算在事务外(查重服务为读路径)——先落 target 与清态,事务外重算后二次落库。
        await tx.importRow.update({
          where: { id: row.id },
          data: {
            parsedData: data as unknown as Prisma.InputJsonValue,
          },
        });
        continue;
      }

      // 以下为科目/年度/强制导入更新:仅 valid 行(与既有行为一致)。
      if (row.validationStatus !== 'valid') {
        throw new HTTPError(422, `第 ${row.rowNo} 行不是有效行,不可更新`);
      }

      if (u.subjectId !== undefined) {
        if (u.subjectId === null) {
          data.subjectId = null;
          data.subjectName = null;
        } else {
          const subj = await getSubject(rowProjectId, u.subjectId);
          if (!subj) {
            throw new HTTPError(422, `第 ${row.rowNo} 行科目不属于目标项目`);
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

  // v3 映射重算(事务外读路径):按新目标重跑 科目预选 + 查重,二次落库。
  for (const job of remapJobs) {
    const leafMap = await leafNameMapByProject(job.target);
    const detailLeaf = job.data.detailPath
      ? (job.data.detailPath.split('/').pop() ?? '').trim()
      : '';
    const pre = detailLeaf ? (leafMap.get(detailLeaf) ?? null) : null;
    job.data.subjectId = pre;
    job.data.subjectName = pre ? detailLeaf : null;
  }
  const remapByTarget = new Map<string, RemapJob[]>();
  for (const job of remapJobs) {
    const g = remapByTarget.get(job.target);
    if (g) g.push(job);
    else remapByTarget.set(job.target, [job]);
  }
  for (const [target, jobs] of remapByTarget) {
    const verdicts = await checkDuplicates(
      target,
      jobs.map((j) => ({
        rowKey: j.row.id,
        docNo: j.data.docNo,
        budgetYear: j.data.budgetYear > 0 ? j.data.budgetYear : null,
        amount: normalizeAmount(j.data.amount),
        businessDate: normalizeDate(j.data.businessDate),
        summary: j.data.summary || null,
        status: j.data.status,
        completedDate: j.data.completedDate ?? null,
      })),
      { allowRefresh: true },
    );
    const verdictByRowId = new Map(verdicts.map((v) => [v.rowKey, v]));
    for (const job of jobs) {
      const v = verdictByRowId.get(job.row.id);
      // 与解析期 applyVerdict 同口径:无命中行保持 clean(否则全被误标进重复组)。
      job.row.duplicateFlag = !!(v?.hard || v?.refresh || v?.suspected);
      job.row.duplicateLevel = v?.hard
        ? 'hard'
        : v?.refresh
          ? 'refresh'
          : v?.suspected
            ? 'suspected'
            : 'none';
      if (v?.hard) job.data.dupReason = hardDupReason(v);
      else job.data.dupReason = null;
      const nextErrors: SettlementRowError[] | null =
        job.baseErrors.length > 0 ? job.baseErrors : null;
      job.nextErrors = nextErrors;
      job.row.validationStatus = job.baseErrors.length === 0 ? 'valid' : 'error';
    }
  }
  if (remapJobs.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const job of remapJobs) {
        await tx.importRow.update({
          where: { id: job.row.id },
          data: {
            parsedData: job.data as unknown as Prisma.InputJsonValue,
            errors: job.nextErrors as unknown as Prisma.InputJsonValue,
            validationStatus: job.row.validationStatus,
            duplicateFlag: job.row.duplicateFlag,
            duplicateLevel: job.row.duplicateLevel,
          },
        });
      }
    }, BULK_TX_OPTIONS);
  }
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
    include: { rows: { orderBy: { rowNo: 'asc' } } },
  });
  if (!batch) {
    throw new HTTPError(404, '导入批次不存在');
  }
  await requirePermission(user, 'record:import', batch.projectId);
  if (!isSettlementTemplateVersion(batch.templateVersion)) {
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

  // 行级目标项目(v3 项目映射):v1/v2 行回退批次项目;逐目标项目复核导入权限。
  const rowProjectId = (row: (typeof batch.rows)[number]): string => {
    const d = row.parsedData as unknown as SettlementParsedRow;
    return d.targetProjectId ?? batch.projectId;
  };
  for (const pid of new Set(eligibleRows.map(rowProjectId))) {
    await requirePermission(user, 'record:import', pid);
  }

  const subjectIdsByProject = new Map<string, Set<string>>();
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
    const pid = rowProjectId(row);
    const set = subjectIdsByProject.get(pid) ?? subjectIdsByProject.set(pid, new Set()).get(pid)!;
    set.add(data.subjectId);
    createRows.push(row);
  }
  const leafIdsByProject = new Map<string, Set<string>>();
  for (const [pid, ids] of subjectIdsByProject) {
    const subjects = await prisma.budgetSubject.findMany({
      where: { projectId: pid, id: { in: [...ids] } },
      select: { id: true, isLeaf: true },
    });
    leafIdsByProject.set(pid, new Set(subjects.filter((s) => s.isLeaf).map((s) => s.id)));
  }
  for (const row of createRows) {
    const data = row.parsedData as unknown as SettlementParsedRow;
    if (!leafIdsByProject.get(rowProjectId(row))!.has(data.subjectId!)) {
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
      // docNo 兜底复查按行目标项目分组(解析到确认之间可能已有同单号入库)。
      const createRowsByProject = new Map<string, typeof createRows>();
      for (const r of createRows) {
        const pid = rowProjectId(r);
        const g = createRowsByProject.get(pid);
        if (g) g.push(r);
        else createRowsByProject.set(pid, [r]);
      }
      for (const [pid, rows] of createRowsByProject) {
        const checkDocNos = [
          ...new Set(
            rows
              .map((r) => (r.parsedData as unknown as SettlementParsedRow).docNo)
              .filter((d): d is string => !!d),
          ),
        ];
        if (checkDocNos.length === 0) continue;
        const conflicts = await tx.businessRecord.findMany({
          where: { projectId: pid, isVoid: false, docNo: { in: checkDocNos } },
          select: { docNo: true },
        });
        if (conflicts.length > 0) {
          // 硬重复无强制通道(ADR 0002):同号已入库一律拒绝,无 forcedImport 豁免。
          const conflictSet = new Set(conflicts.map((c) => c.docNo));
          const badRows = rows
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
          where: { projectId: rowProjectId(row), isVoid: false, docNo },
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
          projectId: rowProjectId(row),
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

      const newRecords = createRows.map((row) => {
        const data = row.parsedData as unknown as SettlementParsedRow;
        const amount = normalizeAmount(data.amount);
        if (!amount) {
          throw new HTTPError(422, `第 ${row.rowNo} 行金额无效`);
        }
        const date = normalizeDate(data.businessDate);
        if (!date) {
          throw new HTTPError(422, `第 ${row.rowNo} 行填制日期无效`);
        }
        // 兜底断言(安全审计 bm1-imp:settlement-budgetyear-bypass):与所有写路径
        // 同规则——历史遗留的越界年度行(校验前入库)不得经确认写入业务记录。
        if (
          !Number.isInteger(data.budgetYear) ||
          data.budgetYear < 1900 ||
          data.budgetYear > 9999
        ) {
          throw new HTTPError(422, `第 ${row.rowNo} 行预算年度必须是 1900~9999 的正整数`);
        }

        const recordId = uuidv7();
        return {
          data: {
            id: recordId,
            projectId: rowProjectId(row),
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
          importRowId: row.id,
          importRowNo: row.rowNo,
          forcedImport: row.duplicateFlag,
        };
      });
      createdIds.push(...(await createImportedRecords(tx, newRecords, batchId, user.id)));

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
