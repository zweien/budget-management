import { User } from '@prisma/client';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeightRule,
  LineRuleType,
  PageNumber,
  Packer,
  Paragraph,
  SectionType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { D, fromStored, sumAmounts } from '@/lib/decimal';
import { executionRate } from '@/lib/budget';
import { formatMoney } from '@/lib/budget/money';
import { withExportSlot } from '@/server/exports/concurrency';
import { getProjectTotalLedger, type LedgerNode } from '@/server/services/ledger.service';
import {
  FUNDING_REPORT_STATUS_TEXT,
  type DetailFieldKey,
  type FundingReportQueryOptions,
  type SummaryColumnKey,
} from '@/lib/fundingReport';

/**
 * 经费报告(Funding Report,见 CONTEXT.md):单项目全周期执行报告(Word)。
 * 前半 = 按所选科目层级的执行汇总表(万元,列头沿用财务模板);后半 = 同一层级
 * 逐科目「完成记账/应付未付」业务明细(元)。作废记录不计;非叶层级取子树上卷。
 *
 * 结构分两层:`buildFundingReportData` 负责权限/取数/上卷/编号/格式化(输出
 * 全部为展示字符串),`buildFundingReportDocx` 只做版式(1:1 复刻 docs/templates/
 * funding-report-template.docx:A4 纵向两分节、黑体/仿宋_GB2312/楷体_GB2312/
 * 方正小标宋简体、细实线表格、27pt 固定行距、无页眉页脚)。
 *
 * 进度:onProgress(percent 0-100, 阶段文案) 在 exportFundingReport 汇总为
 * 全程单调递增序列,路由侧写入导出进度注册表(exports/progress)供前端轮询。
 */

/** 进度回调:percent 0-100(全程单调),phase 为用户可读阶段文案。 */
export type ReportProgressFn = (percent: number, phase: string) => void;

const noopProgress: ReportProgressFn = () => {};

/** 把子流程的 0-100 局部进度线性映射到全程 [from,to] 区间。 */
function scaleProgress(fn: ReportProgressFn, from: number, to: number): ReportProgressFn {
  return (local, phase) => {
    const clamped = Math.min(100, Math.max(0, local));
    fn(from + ((to - from) * clamped) / 100, phase);
  };
}

// ---------------------------------------------------------------------------
// 数据装配
// ---------------------------------------------------------------------------

export interface FundingReportData {
  project: { code: string; name: string };
  /** 说明页标题下的周期括号;取不到起止日期时为 null(版式层落模板占位)。 */
  periodText: string | null;
  summary: {
    columns: SummaryColumnKey[];
    /** 已格式化(万元两位小数/百分比/—),科目名含编号与全角空格缩进。 */
    rows: { label: string; bold: boolean; cells: Record<SummaryColumnKey, string> }[];
    totalRow: { label: string; cells: Record<SummaryColumnKey, string> };
  };
  detail: DetailNode[];
}

export interface DetailRowData {
  cells: Record<DetailFieldKey, string>;
}

export type DetailNode =
  | { kind: 'heading'; level: number; title: string; children: DetailNode[] }
  | {
      kind: 'section';
      title: string;
      lead: string;
      paid: DetailRowData[];
      payable: DetailRowData[];
      paidSumText: string;
      payableSumText: string;
    };

/** 元(两位小数字符串)→ 万元两位小数(ROUND_HALF_UP 由 decimal 全局配置保证)。 */
export function toWanYuan(yuan: string): string {
  return fromStored(yuan).div(10000).toFixed(2);
}

function rateText(rate: number | null): string {
  if (rate === null || Number.isNaN(rate)) return '—';
  return `${(rate * 100).toFixed(2)}%`;
}

const CN_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_TENS = ['', '十', '二十', '三十', '四十', '五十', '六十', '七十', '八十', '九十'];
const CIRCLED = [
  '①',
  '②',
  '③',
  '④',
  '⑤',
  '⑥',
  '⑦',
  '⑧',
  '⑨',
  '⑩',
  '⑪',
  '⑫',
  '⑬',
  '⑭',
  '⑮',
  '⑯',
  '⑰',
  '⑱',
  '⑲',
  '⑳',
];

/** 1~99 → 中文数字(一级科目编号「一、二、…」)。 */
export function chineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n);
  if (n < 10) return CN_DIGITS[n - 1];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  // 10 →「十」;11 →「十一」;20 →「二十」;21 →「二十一」。
  return ones === 0 ? CN_TENS[tens] : `${CN_TENS[tens]}${CN_DIGITS[ones - 1]}`;
}

function circled(n: number): string {
  return n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`;
}

interface TreeNode {
  id: string;
  name: string;
  level: number;
  isLeaf: boolean;
  children: TreeNode[];
  initial: D;
  current: D;
  paid: D;
  payable: D;
  occupied: D;
  balance: D;
  rate: number | null;
  /** DFS 编号后的完整标签,如「一、直接费用」「3.设备费」「（2）设备B」。 */
  numbering: string;
}

const STATUS_TEXT = FUNDING_REPORT_STATUS_TEXT;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 模板日期格式「YYYY年MM月DD日」;@db.Date 经 Prisma 读出为 UTC 零点,直接取 UTC 分量。 */
function cnDate(date: Date): string {
  return `${date.getUTCFullYear()}年${pad2(date.getUTCMonth() + 1)}月${pad2(date.getUTCDate())}日`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function yuanText(value: D): string {
  return formatMoney(value);
}

/** 记录排序:申请日期升序 → 单据编号升序(PG ASC 缺省 NULLS LAST)。 */
const RECORD_ORDER = [{ businessDate: 'asc' as const }, { docNo: 'asc' as const }];

export async function buildFundingReportData(
  projectId: string,
  options: FundingReportQueryOptions,
  user: Pick<User, 'id' | 'role'>,
  onProgress: ReportProgressFn = noopProgress,
): Promise<FundingReportData> {
  if (options.summaryColumns.length === 0) {
    throw new HTTPError(400, '汇总表至少选择一个数值列');
  }
  if (options.detailFields.length === 0) {
    throw new HTTPError(400, '明细表至少选择一个字段');
  }
  onProgress(5, '校验参数');

  // 权限校验在台账服务内;总口径节点已含全部上卷(GENERAL/LUMP_SUM 同源)。
  const ledger = await getProjectTotalLedger(projectId, user);
  const [project, records] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { code: true, name: true, startDate: true, endDate: true },
    }),
    prisma.businessRecord.findMany({
      where: { projectId, isVoid: false },
      orderBy: RECORD_ORDER,
      select: {
        id: true,
        budgetYear: true,
        businessDate: true,
        completedDate: true,
        amount: true,
        status: true,
        docNo: true,
        voucherNo: true,
        handler: true,
        summary: true,
        subjectId: true,
      },
    }),
  ]);
  if (!project) throw new HTTPError(404, '项目不存在');
  if (ledger.nodes.length === 0) {
    throw new HTTPError(422, '项目暂无预算科目，无法生成经费报告');
  }
  onProgress(30, `读取业务记录（${records.length} 条）`);

  // ---- 科目树:扁平 → DFS;层级裁剪 + 逐层编号 ----
  const nodeById = new Map(ledger.nodes.map((n) => [n.subjectId, n]));
  const maxLevel = Math.max(...ledger.nodes.map((n) => n.level));
  const displayDepth = options.level === 'all' ? maxLevel : Math.min(options.level, maxLevel);

  const byParent = new Map<string | null, LedgerNode[]>();
  for (const n of ledger.nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }

  let rootCounter = 0;
  let l2Counter = 0; // 二级编号跨一级连续递增(模板 1~10)。
  const l3Counters = new Map<string, number>(); // 二级父内「（n）」计数。
  const l4Counters = new Map<string, number>();

  const toTreeNode = (node: LedgerNode, numbering: string, children: TreeNode[]): TreeNode => ({
    id: node.subjectId,
    name: node.name,
    level: node.level,
    isLeaf: node.isLeaf,
    children,
    initial: fromStored(node.totalInitial),
    current: fromStored(node.totalCurrent),
    paid: fromStored(node.paid),
    payable: fromStored(node.payable),
    occupied: fromStored(node.totalOccupied),
    balance: fromStored(node.balance),
    rate: node.executionRate,
    numbering,
  });

  const buildNode = (node: LedgerNode): TreeNode => {
    let numbering: string;
    if (node.level === 1) {
      rootCounter += 1;
      numbering = `${chineseNumber(rootCounter)}、${node.name}`;
    } else if (node.level === 2) {
      l2Counter += 1;
      numbering = `${l2Counter}.${node.name}`;
    } else if (node.level === 3) {
      const next = (l3Counters.get(node.parentId ?? '') ?? 0) + 1;
      l3Counters.set(node.parentId ?? '', next);
      numbering = `（${next}）${node.name}`;
    } else {
      const next = (l4Counters.get(node.parentId ?? '') ?? 0) + 1;
      l4Counters.set(node.parentId ?? '', next);
      numbering = `${circled(next)}${node.name}`;
    }
    const children = (byParent.get(node.subjectId) ?? []).map(buildNode);
    return toTreeNode(node, numbering, children);
  };
  const tree = (byParent.get(null) ?? []).map(buildNode);
  onProgress(40, '装配科目树与汇总');

  // ---- 汇总行(展示字符串:万元/百分比;非叶行=上卷小计,加粗) ----
  const summaryRows: FundingReportData['summary']['rows'] = [];
  const collectRows = (node: TreeNode) => {
    if (node.level <= displayDepth) {
      summaryRows.push({
        label: `${'　'.repeat(node.level - 1)}${node.numbering}`,
        bold: !node.isLeaf,
        cells: {
          initial: toWanYuan(node.initial.toFixed(2)),
          current: toWanYuan(node.current.toFixed(2)),
          occupied: toWanYuan(node.occupied.toFixed(2)),
          paid: toWanYuan(node.paid.toFixed(2)),
          payable: toWanYuan(node.payable.toFixed(2)),
          balance: toWanYuan(node.balance.toFixed(2)),
          rate: rateText(node.rate),
        },
      });
    }
    for (const child of node.children) collectRows(child);
  };
  for (const root of tree) collectRows(root);

  // 合计行 = Σ 一级行**已展示的万元值**:与各一级行四舍五入后的可见数字逐列相加
  // 严格相等(两个一级科目各 50 元 → 行 0.01+0.01,合计 0.02,而非精确和的 0.01)。
  // 执行率列不可加,按精确元口径重新计算。
  const sumRoundedWan = (pick: (n: TreeNode) => D): string =>
    sumAmounts(tree.map((n) => fromStored(toWanYuan(pick(n).toFixed(2))))).toFixed(2);
  const totalRow = {
    label: '合　计',
    cells: {
      initial: sumRoundedWan((n) => n.initial),
      current: sumRoundedWan((n) => n.current),
      occupied: sumRoundedWan((n) => n.occupied),
      paid: sumRoundedWan((n) => n.paid),
      payable: sumRoundedWan((n) => n.payable),
      balance: sumRoundedWan((n) => n.balance),
      rate: rateText(
        executionRate(
          sumAmounts(tree.map((n) => n.occupied)),
          sumAmounts(tree.map((n) => n.current)),
        ),
      ),
    } satisfies Record<SummaryColumnKey, string>,
  };

  // ---- 明细:记录归到「所选层级」的祖先节点(叶更浅时归自身) ----
  const sectionIdOf = (subjectId: string): string => {
    let cursor = nodeById.get(subjectId)!;
    while (cursor.level > displayDepth && cursor.parentId !== null) {
      cursor = nodeById.get(cursor.parentId)!;
    }
    return cursor.subjectId;
  };
  const recordsBySection = new Map<string, typeof records>();
  for (const record of records) {
    if (!nodeById.has(record.subjectId)) continue; // 理论不可达(外键),保守跳过。
    const sectionId = sectionIdOf(record.subjectId);
    const list = recordsBySection.get(sectionId) ?? [];
    list.push(record);
    recordsBySection.set(sectionId, list);
  }

  /** 节点是明细小节(挂表)还是仅标题:层级=所选深度,或叶更浅时自身。 */
  const isSectionNode = (node: TreeNode) =>
    node.level === displayDepth || (node.isLeaf && node.level < displayDepth);

  // 明细分节进度:按「有记录的小节」计数,逐节推进 40→98。
  const countSectionNodes = (nodes: TreeNode[]): number =>
    nodes.reduce(
      (acc, node) =>
        acc +
        (isSectionNode(node) && (recordsBySection.get(node.id)?.length ?? 0) > 0
          ? 1
          : countSectionNodes(node.children)),
      0,
    );
  const totalSections = countSectionNodes(tree);
  let doneSections = 0;

  const buildDetailNode = (node: TreeNode): DetailNode | null => {
    if (isSectionNode(node)) {
      const sectionRecords = recordsBySection.get(node.id) ?? [];
      if (sectionRecords.length === 0) return null;
      const paid: DetailRowData[] = [];
      const payable: DetailRowData[] = [];
      for (const record of sectionRecords) {
        const row: DetailRowData = {
          cells: {
            appliedDate: isoDate(record.businessDate),
            completedDate: record.completedDate ? isoDate(record.completedDate) : '—',
            summary: record.summary,
            amount: yuanText(fromStored(record.amount.toFixed(2))),
            handler: record.handler,
            status: STATUS_TEXT[record.status] ?? record.status,
            docNo: record.docNo ?? '',
            voucherNo: record.voucherNo ?? '',
            budgetYear: String(record.budgetYear),
            subject: nodeById.get(record.subjectId)?.name ?? '',
          },
        };
        (record.status === 'PAID' ? paid : payable).push(row);
      }
      const paidSum = sumAmounts(
        sectionRecords.filter((r) => r.status === 'PAID').map((r) => r.amount),
      );
      const payableSum = sumAmounts(
        sectionRecords.filter((r) => r.status !== 'PAID').map((r) => r.amount),
      );
      doneSections += 1;
      onProgress(
        totalSections > 0 ? 40 + (58 * doneSections) / totalSections : 98,
        `装配业务明细（${doneSections}/${totalSections} 节）`,
      );
      return {
        kind: 'section',
        title: node.numbering,
        lead: `共计${yuanText(node.occupied)}元，其中已完成${yuanText(node.paid)}元，应付未付${yuanText(node.payable)}元。`,
        paid,
        payable,
        paidSumText: yuanText(paidSum),
        payableSumText: yuanText(payableSum),
      };
    }
    const children = node.children
      .map(buildDetailNode)
      .filter((child): child is DetailNode => child !== null);
    if (children.length === 0) return null; // 子树无记录:整支不出。
    return { kind: 'heading', level: node.level, title: node.numbering, children };
  };
  const detail = tree.map(buildDetailNode).filter((n): n is DetailNode => n !== null);
  onProgress(100, '数据装配完成');

  // ---- 周期括号:项目起止日期,缺则用记录申请日期的最早/最晚。 ----
  let periodText: string | null = null;
  if (project.startDate && project.endDate) {
    periodText = `${cnDate(project.startDate)}至${cnDate(project.endDate)}`;
  } else if (records.length > 0) {
    const times = records.map((r) => r.businessDate.getTime());
    periodText = `${cnDate(new Date(Math.min(...times)))}至${cnDate(new Date(Math.max(...times)))}`;
  }

  return {
    project: { code: project.code, name: project.name },
    periodText,
    summary: { columns: [...options.summaryColumns], rows: summaryRows, totalRow },
    detail,
  };
}

// ---------------------------------------------------------------------------
// docx 版式(1:1 复刻 docs/templates/funding-report-template.docx)
// ---------------------------------------------------------------------------

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const F_FANG = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '仿宋_GB2312' };
const F_HEI = { ascii: '黑体', hAnsi: '黑体', eastAsia: '黑体' };
const F_KAI = { ascii: '楷体_GB2312', hAnsi: '楷体_GB2312', eastAsia: '楷体_GB2312' };
const F_SONG = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体' };
const F_XBS = { ascii: '方正小标宋简体', hAnsi: '方正小标宋简体', eastAsia: '方正小标宋简体' };

type FontSpec = typeof F_FANG;

function run(text: string, font: FontSpec, size: number, bold = false): TextRun {
  return new TextRun({ text, font, size, bold });
}

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const TABLE_BORDERS = {
  top: BORDER,
  bottom: BORDER,
  left: BORDER,
  right: BORDER,
  insideHorizontal: BORDER,
  insideVertical: BORDER,
};

/** 明细列宽权重(模板 时间/凭证/金额/明细 ≈ 1269/1268/1691/4832 的通用化)。 */
const FIELD_WIDTH_WEIGHTS: Record<DetailFieldKey, number> = {
  appliedDate: 2.0,
  completedDate: 2.0,
  budgetYear: 1.2,
  docNo: 2.2,
  voucherNo: 2.2,
  amount: 1.8,
  status: 2.2,
  handler: 1.8,
  subject: 3.0,
  summary: 4.0,
};
/** 明细表居中列(数字/日期/状态);文本列左对齐。 */
const FIELD_CENTERED: ReadonlySet<DetailFieldKey> = new Set([
  'appliedDate',
  'completedDate',
  'budgetYear',
  'amount',
  'status',
]);

/**
 * 报告内明细表头文案:默认四列复用模板原文(时间/凭证编号/金额/明细),
 * 其余字段用系统字段名;用户换字段时表头随之变化(如 完成日期)。
 */
const DETAIL_REPORT_LABELS: Record<DetailFieldKey, string> = {
  appliedDate: '时间',
  completedDate: '完成日期',
  summary: '明细',
  amount: '金额(元)',
  handler: '经办人',
  status: '状态',
  docNo: '单据编号',
  voucherNo: '凭证编号',
  budgetYear: '预算年度',
  subject: '科目',
};

/** 汇总表头文案(模板原文;≥5 字预折两行,模板同款)。 */
const SUMMARY_REPORT_LABELS: Record<SummaryColumnKey, string> = {
  initial: '合同总\n预算',
  current: '调整后\n预算',
  occupied: '实际开支\n情况',
  paid: '账面支出\n情况',
  payable: '应付未付',
  balance: '结余',
  rate: '执行率',
};

/** 说明页正文行距:模板 342900 EMU = 27pt 固定。 */
const BODY_SPACING = { line: 540, lineRule: LineRuleType.EXACT } as const;

function cell(
  text: string,
  width: number,
  opts: { bold?: boolean; center?: boolean; size?: number } = {},
): TableCell {
  // 模板同款:表头文案可带 \n 预折行(如「合同总\n预算」)。
  const lines = text.split('\n');
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    children: lines.map(
      (line) =>
        new Paragraph({
          alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: [run(line, F_FANG, opts.size ?? 21, opts.bold ?? false)],
        }),
    ),
  });
}

function buildSummaryTable(data: FundingReportData): Table {
  // 表宽收在版心内(11906 − 2×1588 = 8730):模板表声明宽略溢出版心,
  // 由 Word 自动收进;生成侧直接按版心宽出,渲染器(CJK 回退字体)均不截断。
  const NAME_WIDTH = 2700;
  const TOTAL_WIDTH = 8730;
  const columns = data.summary.columns;
  const numericWidth = Math.floor((TOTAL_WIDTH - NAME_WIDTH) / Math.max(columns.length, 1));

  const header = new TableRow({
    tableHeader: true,
    // 模板为 exact 625;生成侧两行表头在 CJK 回退字体下行高需自适应,放开为 atLeast。
    height: { value: 625, rule: HeightRule.ATLEAST },
    children: [
      cell('科目名称', NAME_WIDTH, { bold: true, center: true }),
      ...columns.map((key) =>
        cell(SUMMARY_REPORT_LABELS[key], numericWidth, { bold: true, center: true }),
      ),
    ],
  });

  const rows = data.summary.rows.map(
    (row) =>
      new TableRow({
        cantSplit: true,
        height: { value: 499, rule: HeightRule.ATLEAST },
        children: [
          cell(row.label, NAME_WIDTH, { bold: row.bold }),
          ...columns.map((key) =>
            cell(row.cells[key], numericWidth, { bold: row.bold, center: true }),
          ),
        ],
      }),
  );

  const total = new TableRow({
    cantSplit: true,
    height: { value: 499, rule: HeightRule.ATLEAST },
    children: [
      cell(data.summary.totalRow.label, NAME_WIDTH, { bold: true }),
      ...columns.map((key) =>
        cell(data.summary.totalRow.cells[key], numericWidth, { bold: true, center: true }),
      ),
    ],
  });

  return new Table({
    width: { size: TOTAL_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: TABLE_BORDERS,
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    rows: [header, ...rows, total],
  });
}

/**
 * 列宽分配:按权重比例分满总宽,逐轮抬底(低于下限的列固定下限,其余按权重
 * 重分剩余),最后取整并把舍入余数校正到最宽列——保证 Σ列宽 严格等于总宽
 * (固定布局下不溢出、声明宽度即渲染宽度)。
 */
function allocateWidths(total: number, weights: number[], min: number): number[] {
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  let widths = weights.map((w) => (total * w) / weightSum);
  const fixed = new Array<boolean>(weights.length).fill(false);
  for (;;) {
    const below = widths.findIndex((w, i) => !fixed[i] && w < min);
    if (below < 0) break;
    fixed[below] = true;
    const restWidth = total - min * fixed.filter(Boolean).length;
    const restWeight = weights.reduce((acc, w, i) => acc + (fixed[i] ? 0 : w), 0);
    if (restWeight <= 0) break;
    widths = widths.map((w, i) => (fixed[i] ? min : (restWidth * weights[i]) / restWeight));
  }
  const rounded = widths.map((w) => Math.round(w));
  rounded[rounded.indexOf(Math.max(...rounded))] += total - rounded.reduce((a, b) => a + b, 0);
  return rounded;
}

/** 超长单元格阈值:超过它的行放开 cantSplit,允许跨页(防单行高过一页被截断)。 */
const ROW_SPLIT_THRESHOLD = 120;

function buildDetailTable(
  fields: DetailFieldKey[],
  rows: DetailRowData[],
  sumText: string | null,
): Table {
  const TOTAL_WIDTH = 8844; // 说明页版心宽(11906 − 1588 − 1474)。
  const widths = allocateWidths(
    TOTAL_WIDTH,
    fields.map((key) => FIELD_WIDTH_WEIGHTS[key]),
    600,
  );

  const header = new TableRow({
    tableHeader: true,
    height: { value: 500, rule: HeightRule.ATLEAST },
    children: fields.map((key, i) =>
      cell(DETAIL_REPORT_LABELS[key], widths[i], { bold: true, center: true }),
    ),
  });

  const body = rows.map((row) => {
    const longest = Math.max(...fields.map((key) => row.cells[key].length));
    return new TableRow({
      // 摘要等文本无长度上限:超长行允许跨页,普通短行整行不拆。
      cantSplit: longest <= ROW_SPLIT_THRESHOLD,
      height: { value: 440, rule: HeightRule.ATLEAST },
      children: fields.map((key, i) =>
        cell(row.cells[key], widths[i], { center: FIELD_CENTERED.has(key) }),
      ),
    });
  });

  // 合计行:有金额列 → 标签落在首个非金额列、金额列落数值;金额是唯一字段时
  // 同格「合计：<数>」;未选金额列 → 首格「合计：<数>元」保留合计信息。
  const amountIndex = fields.indexOf('amount');
  const totalCells = (): TableCell[] => {
    if (amountIndex < 0) {
      return fields.map((key, i) =>
        i === 0 && sumText !== null
          ? cell(`合计：${sumText}元`, widths[i], { bold: true })
          : cell('', widths[i]),
      );
    }
    const labelIndex = fields.length > 1 ? (amountIndex === 0 ? 1 : 0) : -1;
    return fields.map((key, i) => {
      if (i === amountIndex) {
        const text = labelIndex < 0 && sumText !== null ? `合计：${sumText}` : (sumText ?? '');
        return cell(text, widths[i], { bold: true, center: true });
      }
      if (i === labelIndex) return cell('合计', widths[i], { bold: true });
      return cell('', widths[i]);
    });
  };
  const totalRow =
    sumText === null
      ? []
      : [
          new TableRow({
            cantSplit: true,
            height: { value: 440, rule: HeightRule.ATLEAST },
            children: totalCells(),
          }),
        ];

  return new Table({
    width: { size: TOTAL_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: TABLE_BORDERS,
    margins: { top: 30, bottom: 30, left: 80, right: 80 },
    rows: [header, ...body, ...totalRow],
  });
}

function detailParagraph(text: string, font: FontSpec, size: number, keepNext = false): Paragraph {
  return new Paragraph({
    spacing: BODY_SPACING,
    keepNext,
    children: [run(text, font, size)],
  });
}

function buildDetailChildren(
  nodes: DetailNode[],
  fields: DetailFieldKey[],
  children: (Paragraph | Table)[],
  onSection?: () => void,
): void {
  for (const node of nodes) {
    if (node.kind === 'heading') {
      // 一级 = 黑体 16pt 大标题;更深中间层 = 仿宋 14pt(与模板层级字号一致)。
      children.push(
        new Paragraph({
          spacing: { ...BODY_SPACING, before: 120 },
          keepNext: true,
          children: [
            run(node.title, node.level === 1 ? F_HEI : F_FANG, node.level === 1 ? 32 : 28),
          ],
        }),
      );
      buildDetailChildren(node.children, fields, children, onSection);
      continue;
    }
    // 小节标题/导语/（1）（2）标签 keepNext:标签不与它的表格分页分离。
    children.push(detailParagraph(node.title, F_FANG, 28, true));
    children.push(detailParagraph(node.lead, F_FANG, 28, true));
    if (node.paid.length > 0) {
      children.push(detailParagraph('（1）完成记账', F_FANG, 28, true));
      children.push(buildDetailTable(fields, node.paid, node.paidSumText));
    }
    if (node.payable.length > 0) {
      children.push(detailParagraph('（2）应付未付', F_FANG, 28, true));
      children.push(buildDetailTable(fields, node.payable, node.payableSumText));
    }
    onSection?.();
  }
}

/** 页脚「—N—」居中页码(模板 footer 同款)。 */
function pageNumberFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ children: ['—', PageNumber.CURRENT, '—'], font: F_SONG, size: 21 }),
        ],
      }),
    ],
  });
}

/** 数明细树里的小节数(进度分母)。 */
function countDetailSections(nodes: DetailNode[]): number {
  return nodes.reduce(
    (acc, node) => acc + (node.kind === 'section' ? 1 : countDetailSections(node.children)),
    0,
  );
}

/** 纯版式层:数据(展示字符串)→ docx Buffer。无 DB/权限副作用。 */
export async function buildFundingReportDocx(
  data: FundingReportData,
  options: FundingReportQueryOptions,
  onProgress: ReportProgressFn = noopProgress,
): Promise<Buffer> {
  onProgress(5, '生成汇总表');
  const summaryChildren: (Paragraph | Table)[] = [
    new Paragraph({
      children: [run(`项目名称：${data.project.name}（编号：${data.project.code}）`, F_FANG, 24)],
    }),
    new Paragraph({
      spacing: { line: 480, lineRule: LineRuleType.EXACT },
      children: [run('一、协议经费执行情况', F_HEI, 28)],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 120 },
      children: [run('金额单位：万元', F_KAI, 24)],
    }),
    buildSummaryTable(data),
    // 模板同款签署栏(模板为浮动文本框,生成侧按正文行落在表下)。
    new Paragraph({
      spacing: { before: 720 },
      children: [
        run(
          '项目负责人（签字）：　　　　　　　　　　财务部门（盖章）：　　　　　　　　　　　　　年　　月　　日',
          F_FANG,
          24,
        ),
      ],
    }),
  ];

  const periodText = data.periodText ?? 'XXXX年XX月XX日至XXXX年XX月XX日';
  const detailChildren: (Paragraph | Table)[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [run('经费开支说明', F_XBS, 40)],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [run(`（${periodText}）`, F_SONG, 24)],
    }),
  ];
  // 明细 Word 表格逐节推进 10→90;docx 构造与 zip 打包各占一段。
  const totalSections = countDetailSections(data.detail);
  let doneSections = 0;
  buildDetailChildren(data.detail, options.detailFields, detailChildren, () => {
    doneSections += 1;
    onProgress(
      totalSections > 0 ? 10 + (80 * doneSections) / totalSections : 90,
      `生成 Word 明细（${doneSections}/${totalSections} 节）`,
    );
  });

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: F_SONG, size: 21 },
        },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 1418, bottom: 1418, left: 1588, right: 1588 } } },
        footers: { default: pageNumberFooter() },
        children: summaryChildren,
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { margin: { top: 2041, bottom: 1985, left: 1588, right: 1474 } },
        },
        footers: { default: pageNumberFooter() },
        children: detailChildren,
      },
    ],
  });
  onProgress(92, '打包 Word 文档');
  const buffer = await Packer.toBuffer(doc);
  onProgress(100, '文档就绪');
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

/**
 * 组合入口:取数 → docx。先做轻量权限校验与记录计数——超 MAX_EXPORT_ROWS 直接
 * 413(与统计导出同口径,防只读凭证反复触发无界物化);计数也决定并发槽档位,
 * 全量取数/装配/docx 生成整体在槽内执行(大请求不会同时持有整份报告数据)。
 */
export async function exportFundingReport(
  projectId: string,
  options: FundingReportQueryOptions,
  user: Pick<User, 'id' | 'role'>,
  onProgress: ReportProgressFn = noopProgress,
): Promise<{ buffer: Buffer; filename: string }> {
  await requirePermission(user, 'project:view', projectId);
  const recordCount = await prisma.businessRecord.count({
    where: { projectId, isVoid: false },
  });
  if (recordCount > env.MAX_EXPORT_ROWS) {
    throw new HTTPError(413, `导出行数超过上限 ${env.MAX_EXPORT_ROWS},请缩小项目范围或分年度导出`);
  }
  onProgress(10, `统计记录数（${recordCount} 条）`);
  return withExportSlot(recordCount >= 2000, async () => {
    const data = await buildFundingReportData(
      projectId,
      options,
      user,
      scaleProgress(onProgress, 12, 55),
    );
    const buffer = await buildFundingReportDocx(data, options, scaleProgress(onProgress, 55, 97));
    const date = new Date();
    const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
    onProgress(99, '准备下载');
    return { buffer, filename: `经费报告-${data.project.code}-${stamp}.docx` };
  });
}
