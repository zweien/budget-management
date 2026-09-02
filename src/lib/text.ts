/** 跨域共用的文本归一化(查重指纹、科目映射记忆等必须同一口径)。 */

/** 去首尾空白 + 压缩连续空白(不改变大小写——单据/摘要场景大小写有语义)。 */
export function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}
