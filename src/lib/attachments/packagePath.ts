/**
 * 按预算科目层级打包附件 — 路径与文件名构建(纯函数,无 IO/无 DB)。
 *
 * 文件夹路径:walk 附件所属叶科目的 parentId 到根,每段取科目名称。
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
 * 构建根→叶的文件夹路径,每段取科目名称消毒后用 `/` 连接
 * (目录给人看,不带编码)。subjectId 不在 map → 空串(防御)。
 * 注意:名称与编码都必须过 sanitizeSegment——编码兜底不过消毒会引入
 * `../` 之类目录段,对不严格的解压器构成 zip-slip(codex review major)。
 * 兄弟同名消歧请用 buildFolderPaths(打包路由用它,单链版保留供测试)。
 */
export function buildFolderPath(subjectId: string, subjectById: Map<string, SubjectNode>): string {
  const chain: SubjectNode[] = [];
  let cur = subjectById.get(subjectId);
  if (!cur) return '';
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? subjectById.get(cur.parentId) : undefined;
  }
  return chain
    .map((s) => sanitizeSegment(s.name) || sanitizeSegment(s.code) || s.id)
    .filter(Boolean)
    .join('/');
}

/**
 * 全树批量构建 subjectId → 文件夹路径(打包路由入口)。
 * 在 buildFolderPath 基础上做兄弟同名消歧:同一父节点下消毒后同名的
 * 科目(名称不保证唯一,如「试验/测试」与「试验:测试」)后者追加
 * `_${编码}`;追加后仍与其他最终目录名相同时继续加序号,保证全树
 * 目录名互不重复(不同科目的附件绝不混入同一目录)。
 * subjects 顺序即消歧顺序,调用方应传 sortOrder/code 排序后的全量。
 */
export function buildFolderPaths(subjects: SubjectNode[]): Map<string, string> {
  const byId = new Map(subjects.map((s) => [s.id, s]));
  // 父节点(含根 null)→ 子科目分组,保持传入顺序。
  const childrenOf = new Map<string | null, SubjectNode[]>();
  for (const s of subjects) {
    const list = childrenOf.get(s.parentId ?? null) ?? [];
    list.push(s);
    childrenOf.set(s.parentId ?? null, list);
  }
  // 段名消歧:对「最终目录名」探测去重——同名兄弟追加 `_${编码}`;
  // 追加后仍撞(与第三方的原名或其他消歧名相同,如 x/x/x_B 三方)继续加序号。
  const segById = new Map<string, string>();
  for (const kids of childrenOf.values()) {
    const usedNames = new Set<string>();
    for (const k of kids) {
      const base = sanitizeSegment(k.name) || sanitizeSegment(k.code) || k.id;
      let seg = base;
      if (usedNames.has(seg)) {
        const suffix = sanitizeSegment(k.code) || k.id;
        seg = `${base}_${suffix}`;
        for (let i = 2; usedNames.has(seg); i++) seg = `${base}_${suffix}(${i})`;
      }
      usedNames.add(seg);
      segById.set(k.id, seg);
    }
  }
  const paths = new Map<string, string>();
  for (const s of subjects) {
    const chain: string[] = [];
    let cur: SubjectNode | undefined = s;
    while (cur) {
      const seg = segById.get(cur.id);
      if (seg) chain.unshift(seg);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    paths.set(s.id, chain.join('/'));
  }
  return paths;
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
 * 渲染后整体消毒并补齐原文件扩展名(模板不含 {original} 或不在末尾时,
 * zip 内条目将没有后缀,Windows 无法识别类型);超长(>200)截断保留扩展名。
 */
export function renderFilename(template: string, ctx: TokenContext): string {
  const tpl = template.trim() || '{original}';
  const rendered = tpl.replace(/\{(\w+)\}/g, (full, key: string) => {
    const fn = TOKENS[key];
    return fn ? fn(ctx) : full;
  });
  // 消毒后为空(模板值全空/全非法字符)→ 回退原文件名。
  let name = ensureExtension(
    sanitizeSegment(rendered) || sanitizeSegment(ctx.original),
    ctx.original,
  );
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name;
}

/** 文件名扩展名(含点,小写;无扩展名为空串)。 */
export function extOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** 保证 name 以 original 的扩展名结尾:已一致不动,缺失/不在末尾则补上。 */
export function ensureExtension(name: string, original: string): string {
  const ext = extOfName(sanitizeSegment(original));
  return ext && !name.toLowerCase().endsWith(ext) ? name + ext : name;
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
