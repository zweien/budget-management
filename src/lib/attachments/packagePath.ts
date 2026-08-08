/**
 * 按预算科目层级打包附件 — 路径与文件名构建(纯函数,无 IO/无 DB)。
 *
 * 文件夹路径:walk 附件所属叶科目的 parentId 到根,每段 `${code}_${name}`。
 * 文件名:占位符模板渲染({date}/{amount}/.../{original})。
 * 全部经过 OS 安全消毒(防 zip-slip 与 Windows 非法字符)。
 */

export interface SubjectNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  level: number;
  isLeaf: boolean;
}

export interface TokenContext {
  date: string; // yyyy-mm-dd
  amount: string; // 2 位小数
  handler: string;
  subject: string; // 叶科目名
  summary: string;
  status: string; // 枚举字符串
  year: string;
  original: string; // 原文件名(含扩展名)
}

const ILLEGAL_CHARS = /[\\/:*?"<>|\0]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 200;

/**
 * 单段(文件夹名/文件名)消毒:替换非法字符 + Windows 保留名 + 去首尾空格点。
 * Windows 保留名检查针对 basename(去扩展名部分),否则 `CON.pdf` 会漏判。
 */
export function sanitizeSegment(s: string): string {
  let out = s
    .replace(ILLEGAL_CHARS, '_')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const dot = out.lastIndexOf('.');
  // basename = 去扩展名部分(dot>0 时);无扩展名时 basename = 整串
  const basename = dot > 0 ? out.slice(0, dot) : out;
  const ext = dot > 0 ? out.slice(dot) : '';
  if (WINDOWS_RESERVED.test(basename)) {
    out = `${basename}_${ext}`;
  } else if (dot <= 0 && WINDOWS_RESERVED.test(out)) {
    // 无扩展名的整串保留名(原逻辑的兜底防御)
    out = `${out}_`;
  }
  return out;
}

/**
 * 构建根→叶的文件夹路径,每段 `${code}_${name}` 消毒后用 `/` 连接。
 * subjectId 不在 map → 空串(调用方应保证存在,此处防御)。
 */
export function buildFolderPath(subjectId: string, subjectById: Map<string, SubjectNode>): string {
  const chain: SubjectNode[] = [];
  let cur = subjectById.get(subjectId);
  if (!cur) return '';
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? subjectById.get(cur.parentId) : undefined;
  }
  return chain.map((s) => sanitizeSegment(`${s.code}_${s.name}`)).join('/');
}

/** 占位符 → 取值函数。 */
const TOKENS: Record<string, (ctx: TokenContext) => string> = {
  date: (c) => c.date,
  amount: (c) => c.amount,
  handler: (c) => c.handler,
  subject: (c) => c.subject,
  summary: (c) => c.summary,
  status: (c) => c.status,
  year: (c) => c.year,
  original: (c) => c.original,
};

/**
 * 渲染文件名:把 {token} 替换为对应值,未知占位符原样保留。
 * 渲染后整体消毒;空模板 → 用 original 兜底;超长(>200)截断保留扩展名。
 */
export function renderFilename(template: string, ctx: TokenContext): string {
  const tpl = template.trim() || '{original}';
  let out = tpl.replace(/\{(\w+)\}/g, (full, key: string) => {
    const fn = TOKENS[key];
    return fn ? fn(ctx) : full;
  });
  out = sanitizeSegment(out);
  if (out.length > MAX_NAME) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 10 ? out.slice(dot) : '';
    out = out.slice(0, MAX_NAME - ext.length) + ext;
  }
  return out;
}

/**
 * 同一文件夹下文件名去重:冲突时在扩展名前追加 (1)/(2)…,并更新 used 计数。
 * 循环探测直到生成未被占用的候选名 — 防止与真实存在的 (N) 文件撞车导致 JSZip 静默覆盖。
 * used.get(name) 语义:该 name(含其变体)被登记的次数;第 N 次(N≥2)调用取 (N-1) 起步探测。
 */
export function dedupeName(name: string, used: Map<string, number>): string {
  const count = used.get(name) ?? 0;
  used.set(name, count + 1);
  if (count === 0) return name;
  // count >= 1:name 已占用,循环找未占用的 (count)/(count+1)/…
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = count;
  let candidate: string;
  do {
    candidate = `${stem}(${n})${ext}`;
    n += 1;
  } while (used.has(candidate));
  // 占用 candidate(若已被预登记则累加,防御性)
  used.set(candidate, (used.get(candidate) ?? 0) + 1);
  return candidate;
}
