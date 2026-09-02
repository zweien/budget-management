import { prisma } from '@/lib/prisma';
import { normalizeWhitespace } from '@/lib/text';

/**
 * 统一查重判定器(ADR 0002):所有业务记录写入口(标准模板导入 / 结算单导入 /
 * 手动新增编辑 / MCP)共用的重复数据防护。
 *
 * 两档语义(见 CONTEXT.md「硬重复」「疑似重复」「查重指纹」):
 * - **硬重复**:单据编号(docNo)在项目内命中未作废记录,或同一编号在本批内出现 2+ 次
 *   ——视为同一笔,禁止入账;作废旧记录后编号即释放,可重新导入。数据库以
 *   partial unique index (project_id, docNo) WHERE … AND is_void = false 兜底。
 * - **疑似重复**:无编号行按指纹(年度+金额+业务日期+摘要归一化)命中既有记录或本批内重复
 *   ——仅提示,由人工判断,可强制导入。
 *
 * 作废记录不参与判定(不占编号、不算指纹);跨项目不查(唯一性以项目为界)。
 */

export interface DuplicateCheckRow {
  /** 调用方行引用(Excel 行号 / ImportRow id 等),原样回传。 */
  rowKey: string;
  /** 单据编号(原样;判定前内部 trim,空串视同 null)。 */
  docNo?: string | null;
  budgetYear: number | null;
  /** 规范化金额字符串(如 '450.00');null 则跳过指纹。 */
  amount: string | null;
  /** yyyy-mm-dd;null 则跳过指纹。 */
  businessDate: string | null;
  summary: string | null;
}

export interface DuplicateConflict {
  recordId: string;
  docNo: string | null;
  budgetYear: number;
  amount: string;
  businessDate: string;
  summary: string;
}

export interface DuplicateRowVerdict {
  rowKey: string;
  /** 硬重复:禁止入账。 */
  hard: boolean;
  /** 疑似重复:提示后可人工强制导入。 */
  suspected: boolean;
  /** 命中的既有记录(硬重复必有;疑似重复通常有)。 */
  conflicts: DuplicateConflict[];
  /** 硬重复来源:db=项目内已有同号记录;inFile=本批内同号出现 2+ 次。 */
  hardSource?: 'db' | 'inFile';
  /** hardSource=inFile 时,本批内首次出现该编号的行引用。 */
  inFileDupOf?: string;
}

export interface CheckDuplicatesOptions {
  /** 编辑场景排除自身(避免与自己的旧值判重)。 */
  excludeRecordId?: string;
}

function normDocNo(docNo: string | null | undefined): string | null {
  const t = docNo?.trim();
  return t ? t : null;
}

function fingerprintOf(year: number, amount: string, date: string, summary: string): string {
  return `${year}|${amount}|${date}|${normalizeWhitespace(summary)}`;
}

/**
 * 对一批待写入行做重复判定(只读;不落任何标记)。
 * 部分字段缺失的行:docNo 缺失才走指纹;指纹四要素不全则跳过指纹判定。
 */
export async function checkDuplicates(
  projectId: string,
  rows: DuplicateCheckRow[],
  opts: CheckDuplicatesOptions = {},
): Promise<DuplicateRowVerdict[]> {
  const verdicts = new Map<string, DuplicateRowVerdict>(
    rows.map((r) => [r.rowKey, { rowKey: r.rowKey, hard: false, suspected: false, conflicts: [] }]),
  );
  if (rows.length === 0) return [];

  // ---- 批内互查:docNo 第 2 次起 = 硬重复;指纹第 2 次起 = 疑似 ----
  const firstByDocNo = new Map<string, string>();
  const firstByFp = new Map<string, string>();
  const docNos = new Set<string>();
  for (const r of rows) {
    const docNo = normDocNo(r.docNo);
    if (docNo) {
      docNos.add(docNo);
      if (firstByDocNo.has(docNo)) {
        const v = verdicts.get(r.rowKey)!;
        v.hard = true;
        v.hardSource = 'inFile';
        v.inFileDupOf = firstByDocNo.get(docNo);
      } else {
        firstByDocNo.set(docNo, r.rowKey);
      }
    } else if (
      r.budgetYear !== null &&
      r.amount !== null &&
      r.businessDate !== null &&
      r.summary !== null
    ) {
      const fp = fingerprintOf(r.budgetYear, r.amount, r.businessDate, r.summary);
      if (firstByFp.has(fp)) {
        verdicts.get(r.rowKey)!.suspected = true;
      } else {
        firstByFp.set(fp, r.rowKey);
      }
    }
  }

  // ---- 与既有记录比对(仅未作废;编辑排除自身) ----
  const exclude = opts.excludeRecordId ? { id: { not: opts.excludeRecordId } } : {};

  // 1) docNo 命中 → 硬重复。
  if (docNos.size > 0) {
    const docNoHits = await prisma.businessRecord.findMany({
      where: { projectId, isVoid: false, docNo: { in: [...docNos] }, ...exclude },
      select: {
        id: true,
        docNo: true,
        budgetYear: true,
        amount: true,
        businessDate: true,
        summary: true,
      },
    });
    const byDocNo = new Map(docNoHits.map((h) => [h.docNo as string, h]));
    for (const r of rows) {
      const docNo = normDocNo(r.docNo);
      if (!docNo) continue;
      const hit = byDocNo.get(docNo);
      if (hit) {
        const v = verdicts.get(r.rowKey)!;
        if (!v.hard) v.hardSource = 'db';
        v.hard = true;
        if (!v.conflicts.some((c) => c.recordId === hit.id)) {
          v.conflicts.push({
            recordId: hit.id,
            docNo: hit.docNo,
            budgetYear: hit.budgetYear,
            amount: hit.amount.toFixed(2),
            businessDate: hit.businessDate.toISOString().slice(0, 10),
            summary: hit.summary,
          });
        }
      }
    }
  }

  // 2) 指纹命中(仅无编号行)→ 疑似。
  const fpRows = rows.filter(
    (r) =>
      normDocNo(r.docNo) === null &&
      r.budgetYear !== null &&
      r.amount !== null &&
      r.businessDate !== null &&
      r.summary !== null,
  );
  if (fpRows.length > 0) {
    const yearSet = new Set(fpRows.map((r) => r.budgetYear as number));
    const existing = await prisma.businessRecord.findMany({
      where: { projectId, isVoid: false, budgetYear: { in: [...yearSet] }, ...exclude },
      select: {
        id: true,
        docNo: true,
        budgetYear: true,
        amount: true,
        businessDate: true,
        summary: true,
      },
    });
    const fpToRecord = new Map<string, (typeof existing)[number]>();
    for (const rec of existing) {
      const fp = fingerprintOf(
        rec.budgetYear,
        rec.amount.toFixed(2),
        rec.businessDate.toISOString().slice(0, 10),
        rec.summary,
      );
      if (!fpToRecord.has(fp)) fpToRecord.set(fp, rec);
    }
    for (const r of fpRows) {
      const fp = fingerprintOf(r.budgetYear!, r.amount!, r.businessDate!, r.summary!);
      const hit = fpToRecord.get(fp);
      if (hit) {
        const v = verdicts.get(r.rowKey)!;
        v.suspected = true;
        if (!v.conflicts.some((c) => c.recordId === hit.id)) {
          v.conflicts.push({
            recordId: hit.id,
            docNo: hit.docNo,
            budgetYear: hit.budgetYear,
            amount: hit.amount.toFixed(2),
            businessDate: hit.businessDate.toISOString().slice(0, 10),
            summary: hit.summary,
          });
        }
      }
    }
  }

  return rows.map((r) => verdicts.get(r.rowKey)!);
}
