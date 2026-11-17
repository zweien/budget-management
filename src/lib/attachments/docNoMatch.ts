/**
 * 批量附件导入的单据编号前缀匹配(CONTEXT.md「批量附件导入」)。
 *
 * 规则:文件名以某 docNo 开头、且其后一字符为非 ASCII 字母数字
 * (分隔符/中文/扩展名点/结尾皆可)即命中;多条命中取最长;
 * 大小写敏感、不做折叠(财务系统编号原样匹配)。
 */

const ASCII_ALNUM = /[A-Za-z0-9]/;

/** docNo 是否以合法边界出现在 fileName 开头。 */
function isBoundaryMatch(fileName: string, docNo: string): boolean {
  if (!docNo || !fileName.startsWith(docNo)) return false;
  const next = fileName[docNo.length];
  return next === undefined || !ASCII_ALNUM.test(next);
}

/**
 * 在候选 docNo 列表里找 fileName 的唯一/最长前缀命中。
 * @returns 命中的 docNo;无命中返回 null。
 */
export function matchDocNo(fileName: string, docNos: readonly string[]): string | null {
  let best: string | null = null;
  for (const docNo of docNos) {
    if (!docNo) continue;
    if (isBoundaryMatch(fileName, docNo) && (best === null || docNo.length > best.length)) {
      best = docNo;
    }
  }
  return best;
}
