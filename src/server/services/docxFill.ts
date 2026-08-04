/**
 * 纯 Node docx 模板填充器(无 Python 依赖,无子进程)。
 *
 * 用 jszip 打开 docx(本质是 zip),取 word/document.xml 做字符串级操作:
 *  - 按 <w:tr> 切表格行、<w:tc> 切单元格。
 *  - 设置单元格文本:保留首个 run 的 rPr 格式,替换其 <w:t> 文本,删多余 run。
 *  - 克隆数据行(深拷贝 <w:tr>)、删除多余空行。
 *  - 重新打包 zip 返回 Buffer。
 *
 * 适用于固定结构的模板(本项目"预算调整-template.docx")。
 */

// 动态 import jszip(jszip 默认导出是构造函数)。
import type JSZipType from 'jszip';
let JSZipCtor: typeof JSZipType | null = null;
async function getJSZip(): Promise<typeof JSZipType> {
  if (!JSZipCtor) {
    const mod = (await import('jszip')) as unknown as { default: typeof JSZipType };
    JSZipCtor = mod.default;
  }
  return JSZipCtor;
}

/** 行/单元格的正则切分工具(非贪婪匹配顶层元素)。 */
const TR_RE = /<w:tr\b[\s>][\s\S]*?<\/w:tr>/g;
const TC_RE = /<w:tc\b[\s>][\s\S]*?<\/w:tc>/g;

/** 提取一个单元格内所有 <w:t> 拼接的可见文本。 */
function cellText(tc: string): string {
  const matches = tc.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [];
  return matches.map((m) => m.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, '')).join('');
}

/**
 * 把单元格的文本替换为 newText,保留首个 run 的格式(rPr)。
 * 策略:保留第一个 <w:p> 的第一个 <w:r> 的 <w:rPr>,把其 <w:t> 改为 newText,
 *      删除该 <w:r> 之后的所有 run,删除其它 <w:p>。
 * 若单元格无 run(空段),在第一个 <w:p> 内追加一个 <w:r><w:t>newText</w:t></w:r>。
 */
function setCellText(tc: string, newText: string, align?: 'left' | 'right' | 'center'): string {
  const text = newText ?? '';
  // 转义 XML 特殊字符。
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 找第一个 <w:p ...>...</w:p>。
  const pMatch = tc.match(/<w:p\b[\s>][\s\S]*?<\/w:p>/);
  if (!pMatch) {
    // 无段落,直接返回原单元格(异常情况)。
    return tc;
  }
  const para = pMatch[0];
  // 提取并清理段落属性 pPr:
  //  - 剔除 <w:numPr>(自动编号),避免与填入的序号文本重复显示;
  //  - 若指定 align,覆盖 <w:jc>(对齐)。
  const pprRawMatch = para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  let ppr = pprRawMatch ? pprRawMatch[0].replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, '') : '';
  if (align) {
    if (/<w:jc w:val="[^"]*"\/>/.test(ppr)) {
      ppr = ppr.replace(/<w:jc w:val="[^"]*"\/>/, `<w:jc w:val="${align}"/>`);
    } else if (ppr) {
      ppr = ppr.replace(/<\/w:pPr>$/, `<w:jc w:val="${align}"/></w:pPr>`);
    } else {
      ppr = `<w:pPr><w:jc w:val="${align}"/></w:pPr>`;
    }
  }
  // 找段落内第一个 <w:r ...>...</w:r>。
  const rMatch = para.match(/<w:r\b[\s>][\s\S]*?<\/w:r>/);
  let newRun: string;
  if (rMatch) {
    const run = rMatch[0];
    // 提取 rPr(若有)。
    const rprMatch = run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    const rpr = rprMatch ? rprMatch[0] : '';
    newRun = `<w:r>${rpr}<w:t xml:space="preserve">${esc}</w:t></w:r>`;
  } else {
    // 段落无 run,新建。
    newRun = `<w:r><w:t xml:space="preserve">${esc}</w:t></w:r>`;
  }
  // 重建段落:用清理后的 pPr + newRun。
  const newPara = `<w:p>${ppr}${newRun}</w:p>`;
  return tc.replace(para, newPara);
}

/** 输入数据结构(与 Python 脚本一致)。 */
export interface DocxFillInput {
  /** 模板 docx 的 Buffer。 */
  templateBuffer: Buffer;
  title: string;
  project: {
    name: string;
    projectType: string;
    undertakingUnit: string;
    ownerName: string;
    researchPeriod: string;
    totalFundWan: string;
    annualFundWan: string;
  };
  reason: string;
  rows: Array<{
    subjectTitle: string;
    productName: string;
    originWan: string;
    adjustedWan: string;
    adjustWan: string;
  }>;
  /** 合计行各金额列(万元):原预算、调整后、调整金额。 */
  totalOriginWan: string;
  totalAdjustedWan: string;
  totalAdjustWan: string;
}

/**
 * 填充模板,返回 docx Buffer。
 * 逻辑列布局(模板实测,见下方注释;python-docx cell(r,c) 等价):
 *  - 项目情况区 行0-3: log1=标签(2列), log3=值, log6=第二标签, log8=第二值
 *  - 调整表头 行5-6, 数据行 行7-19(13空行), 合计行 行20
 *  - 数据行逻辑列: log0序号 log1科目 log2原品名 log4原金额 log5调后品名 log8调后金额 log9调整金额
 *  - 合计行: log0=合计金额标签, log9=合计值
 */
export async function fillAdjustmentTemplate(input: DocxFillInput): Promise<Buffer> {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(input.templateBuffer);
  const docXml = await zip.file('word/document.xml')!.async('string');

  let xml = docXml;

  // ---- 标题:在第一个表格前插入一个居中的标题段落(模板本身无标题占位) ----
  // 先定位表格插入点,再插入标题,最后重新定位表格(位置已偏移)。
  if (input.title) {
    const firstTblIdx = xml.indexOf('<w:tbl');
    const titlePara =
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
      `<w:r><w:rPr><w:rFonts w:hint="eastAsia"/><w:b/><w:sz w:val="32"/></w:rPr>` +
      `<w:t xml:space="preserve">${escapeXml(input.title)}</w:t></w:r></w:p>`;
    xml = xml.slice(0, firstTblIdx) + titlePara + xml.slice(firstTblIdx);
  }

  // ---- 定位第一个 <w:tbl>...</w:tbl> ----
  const tblMatch = xml.match(/<w:tbl\b[\s>][\s\S]*?<\/w:tbl>/);
  if (!tblMatch) {
    throw new Error('模板未找到表格');
  }
  const tbl = tblMatch[0];
  const tblOpen = xml.indexOf(tbl);

  // 提取表头(<w:tbl> 开始标签 + tblPr + tblGrid,直到第一个 <w:tr>)。
  const firstTrIdx = tbl.indexOf('<w:tr');
  const tblHead = tbl.slice(0, firstTrIdx); // <w:tbl><w:tblPr>...</w:tblPr><w:tblGrid>...</w:tblGrid>

  // 切行。
  const allRows: string[] = tbl.match(TR_RE) ?? [];
  // 安全取行(模板结构固定,索引必然存在;缺失则抛错便于排查)。
  const row = (i: number): string => {
    const r = allRows[i];
    if (r === undefined) throw new Error(`模板第 ${i} 行不存在`);
    return r;
  };
  // rows 可变副本(便于整体替换)。
  const rows: string[] = [...allRows];

  // 把"单元格索引"helper:给定 tr 字符串,返回 tc 数组。
  const cellsOf = (tr: string): string[] => tr.match(TC_RE) ?? [];

  /**
   * 按逻辑列(0-based,考虑 gridSpan 合并)取单元格的 tc 字符串与它在 tc 数组中的物理索引。
   * 逻辑列 = 该单元格之前所有 gridSpan 之和。
   */
  const logicalCell = (tr: string, logicalCol: number): { tc: string; physIdx: number } | null => {
    const cells = cellsOf(tr);
    let log = 0;
    for (let i = 0; i < cells.length; i++) {
      const gsMatch = cells[i].match(/<w:gridSpan w:val="(\d+)"/);
      const span = gsMatch ? parseInt(gsMatch[1], 10) : 1;
      if (log === logicalCol) return { tc: cells[i], physIdx: i };
      log += span;
    }
    return null;
  };

  /**
   * 把 tr 中"逻辑列 logicalCol"对应的物理单元格替换为 newText 填充版,返回新 tr。
   * (合并单元格在物理上是一个 tc,直接替换它即可。)
   * align 可选,覆盖单元格段落对齐。
   */
  const setLogicalCell = (
    tr: string,
    logicalCol: number,
    newText: string,
    align?: 'left' | 'right' | 'center',
  ): string => {
    const info = logicalCell(tr, logicalCol);
    if (!info) return tr;
    const newTc = setCellText(info.tc, newText, align);
    return tr.replace(info.tc, newTc);
  };

  // ---- 项目情况区(行0-3) ----
  // 行0: log1=项目名称(标签,不改) log3=项目名称值 → 填 name
  rows[0] = setLogicalCell(row(0), 3, input.project.name);
  // 行1: log3=项目类型值; log8=承担单位值(链式:基于已改的 rows[1])
  rows[1] = setLogicalCell(row(1), 3, input.project.projectType);
  rows[1] = setLogicalCell(rows[1], 8, input.project.undertakingUnit);
  // 行2: log3=项目负责人值; log8=研究周期值
  rows[2] = setLogicalCell(row(2), 3, input.project.ownerName);
  rows[2] = setLogicalCell(rows[2], 8, input.project.researchPeriod);
  // 行3: log3=项目总经费值; log8=年度预算值
  rows[3] = setLogicalCell(row(3), 3, input.project.totalFundWan);
  rows[3] = setLogicalCell(rows[3], 8, input.project.annualFundWan);

  // ---- 调整内容表:数据行模板在行7,空行 7..19(共13) ----
  const DATA_START = 7;
  const BLANK_ROWS = 13;
  const need = Math.max(input.rows.length, 1);

  // 克隆行7(模板数据行)到 need 行。
  const dataTemplateRow = row(DATA_START);
  const dataRows: string[] = [];
  for (let i = 0; i < need; i++) {
    dataRows.push(dataTemplateRow);
  }

  // 填充每行数据。
  input.rows.forEach((r, i) => {
    let tr = dataRows[i];
    tr = setLogicalCell(tr, 0, String(i + 1), 'left'); // 序号列左对齐
    tr = setLogicalCell(tr, 1, r.subjectTitle);
    tr = setLogicalCell(tr, 2, r.productName, 'center'); // 品名列居中
    tr = setLogicalCell(tr, 4, r.originWan);
    tr = setLogicalCell(tr, 5, r.productName, 'center'); // 调后品名列居中
    tr = setLogicalCell(tr, 8, r.adjustedWan);
    tr = setLogicalCell(tr, 9, r.adjustWan);
    dataRows[i] = tr;
  });

  // ---- 合计行:原行20,标签"合计金额"。
  // 合计行布局(log0-1=标签, log2-4=原预算区合并, log5-8=调整后区合并, log9=调整金额)。
  // 故原预算合计填 log2,调整后合计填 log5,调整金额填 log9。
  const HEADER_COUNT = 7; // 行0-6
  const totalRowIndex = HEADER_COUNT + BLANK_ROWS; // 原 20
  let totalRowXml = row(totalRowIndex);
  totalRowXml = setLogicalCell(totalRowXml, 2, input.totalOriginWan); // 原预算金额(合并区)
  totalRowXml = setLogicalCell(totalRowXml, 5, input.totalAdjustedWan); // 调整后金额(合并区)
  totalRowXml = setLogicalCell(totalRowXml, 9, input.totalAdjustWan); // 调整金额
  rows[totalRowIndex] = totalRowXml;

  // ---- 调整原因:定位"XX。"占位单元格替换 ----
  for (let i = totalRowIndex + 1; i < rows.length; i++) {
    if (cellText(rows[i]).includes('XX。') || cellText(rows[i]).trim() === 'XX') {
      // 该行的值单元格是 log2 起的合并区;直接对包含 XX 的单元格替换。
      const cells = cellsOf(rows[i]);
      for (let ci = 0; ci < cells.length; ci++) {
        if (cellText(cells[ci]).includes('XX')) {
          rows[i] = rows[i].replace(cells[ci], setCellText(cells[ci], input.reason));
          break;
        }
      }
      break;
    }
  }

  // ---- 重组表格行:表头(0-6) + 数据行(need 个) + 合计行 + 审批/注意行(原 21 起) ----
  const tailRows = rows.slice(HEADER_COUNT + BLANK_ROWS); // 合计行 + 之后所有行(已改合计与原因)
  const finalRows = [...rows.slice(0, HEADER_COUNT), ...dataRows, ...tailRows];
  // 用 tblHead(含 tblPr/tblGrid)+ finalRows 重建 <w:tbl>...</w:tbl>。
  const newTblFull = `${tblHead}${finalRows.join('')}</w:tbl>`;
  // 替换原 tbl。
  const newXml = xml.slice(0, tblOpen) + newTblFull + xml.slice(tblOpen + tbl.length);

  // ---- 写回 zip ----
  zip.file('word/document.xml', newXml);
  const outBuf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  return outBuf as Buffer;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
