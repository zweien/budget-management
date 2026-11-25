import { describe, it, expect } from 'vitest';

import {
  sanitizeSegment,
  buildFolderPath,
  buildFolderPaths,
  renderFilename,
  dedupeName,
  type SubjectNode,
  type TokenContext,
} from '@/lib/attachments/packagePath';

// 测试用科目树:根 → 二级 → 叶
const subjects: SubjectNode[] = [
  { id: 'root', code: 'ZJF', name: '直接费', parentId: null, level: 1, isLeaf: false },
  { id: 'l2', code: 'SBF', name: '设备费', parentId: 'root', level: 2, isLeaf: false },
  { id: 'leaf', code: 'SBGZF', name: '设备购置费', parentId: 'l2', level: 3, isLeaf: true },
];
const subjectById = new Map(subjects.map((s) => [s.id, s]));

const ctx: TokenContext = {
  date: '2026-08-05',
  amount: '1200.00',
  handler: '张三',
  subject: '设备购置费',
  summary: '差旅费',
  status: 'PAID',
  year: '2026',
  original: '发票.pdf',
  completed: '2026-08-20',
  docNo: 'BX-2026-0311',
  voucherNo: '记-0123',
  remark: '含往返高铁票',
};

describe('sanitizeSegment', () => {
  it('替换路径分隔符与 Windows 非法字符', () => {
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });
  it('NUL 字节替换', () => {
    expect(sanitizeSegment('a\0b')).toBe('a_b');
  });
  it('Windows 保留名追加下划线', () => {
    expect(sanitizeSegment('CON')).toBe('CON_');
    expect(sanitizeSegment('nul')).toBe('nul_');
    expect(sanitizeSegment('COM1')).toBe('COM1_');
    expect(sanitizeSegment('lpt9')).toBe('lpt9_');
  });
  it('Windows 保留名按 basename(去扩展名)检查', () => {
    expect(sanitizeSegment('CON.pdf')).toBe('CON_.pdf');
    expect(sanitizeSegment('nul.txt')).toBe('nul_.txt');
    expect(sanitizeSegment('PRN')).toBe('PRN_');
    expect(sanitizeSegment('正常.pdf')).toBe('正常.pdf');
  });
  it('普通名保留;去首尾空格与点', () => {
    expect(sanitizeSegment('  正常名称  ')).toBe('正常名称');
    expect(sanitizeSegment('.隐藏.')).toBe('隐藏');
  });
});

describe('buildFolderPath', () => {
  it('从叶到根 walk parentId,每段只取科目名称(不带编码)', () => {
    expect(buildFolderPath('leaf', subjectById)).toBe('直接费/设备费/设备购置费');
  });
  it('根节点(无 parentId)只返回自身段', () => {
    expect(buildFolderPath('root', subjectById)).toBe('直接费');
  });
  it('科目名含非法字符时消毒', () => {
    const subs: SubjectNode[] = [
      { id: 'r', code: 'X', name: 'a/b', parentId: null, level: 1, isLeaf: false },
      { id: 'l', code: 'Y', name: '叶', parentId: 'r', level: 2, isLeaf: true },
    ];
    expect(buildFolderPath('l', new Map(subs.map((s) => [s.id, s])))).toBe('a_b/叶');
  });
  it('科目名消毒后为空 → 兜底用编码,不产生空段', () => {
    const subs: SubjectNode[] = [
      { id: 'r', code: 'X', name: ' . . ', parentId: null, level: 1, isLeaf: false },
      { id: 'l', code: 'Y', name: '叶', parentId: 'r', level: 2, isLeaf: true },
    ];
    expect(buildFolderPath('l', new Map(subs.map((s) => [s.id, s])))).toBe('X/叶');
  });
  it('编码兜底同样过消毒:危险编码不产生 ../ 目录穿越(zip-slip)', () => {
    const subs: SubjectNode[] = [
      { id: 'r', code: '../evil', name: '...', parentId: null, level: 1, isLeaf: false },
      { id: 'l', code: 'Y', name: '叶', parentId: 'r', level: 2, isLeaf: true },
    ];
    const path = buildFolderPath('l', new Map(subs.map((s) => [s.id, s])));
    expect(path).not.toMatch(/(^|\/)\.\.?(\/|$)/);
    expect(path).toBe('_evil/叶'); // '../evil' 消毒:非法字符替换 + 去首部点 → '_evil'
  });
  it('subjectId 不在 map 中 → 空字符串(防御)', () => {
    expect(buildFolderPath('unknown', subjectById)).toBe('');
  });
});

describe('buildFolderPaths(全树批量 + 兄弟同名消歧)', () => {
  it('常规树与单链版结果一致', () => {
    const paths = buildFolderPaths(subjects);
    expect(paths.get('leaf')).toBe('直接费/设备费/设备购置费');
    expect(paths.get('root')).toBe('直接费');
  });
  it('兄弟同名消歧:同级消毒后同名,后者追加 _编码', () => {
    // 「试验/测试」与「试验:测试」消毒后同为「试验_测试」→ 后者消歧。
    const subs: SubjectNode[] = [
      { id: 'a', code: 'A1', name: '试验/测试', parentId: null, level: 1, isLeaf: true },
      { id: 'b', code: 'B2', name: '试验:测试', parentId: null, level: 1, isLeaf: true },
    ];
    const paths = buildFolderPaths(subs);
    expect(paths.get('a')).toBe('试验_测试');
    expect(paths.get('b')).toBe('试验_测试_B2'); // 同名 + 编码消歧,不合并目录
  });
  it('不同名兄弟不受消歧影响', () => {
    const subs: SubjectNode[] = [
      { id: 'a', code: 'A1', name: '设备费', parentId: null, level: 1, isLeaf: true },
      { id: 'b', code: 'B2', name: '材料费', parentId: null, level: 1, isLeaf: true },
    ];
    const paths = buildFolderPaths(subs);
    expect(paths.get('a')).toBe('设备费');
    expect(paths.get('b')).toBe('材料费');
  });
  it('三方碰撞链式消歧:x / x_B / x_B_C,最终目录名互不重复', () => {
    // (名 x,码 A)、(名 x,码 B)、(名 x_B,码 C):第三个的消歧候选 x_B
    // 撞上第二个的最终名 → 须继续探测到 x_B_C(codex review major)。
    const subs: SubjectNode[] = [
      { id: 'a', code: 'A', name: 'x', parentId: null, level: 1, isLeaf: true },
      { id: 'b', code: 'B', name: 'x', parentId: null, level: 1, isLeaf: true },
      { id: 'c', code: 'C', name: 'x_B', parentId: null, level: 1, isLeaf: true },
    ];
    const paths = buildFolderPaths(subs);
    expect(paths.get('a')).toBe('x');
    expect(paths.get('b')).toBe('x_B');
    expect(paths.get('c')).toBe('x_B_C');
    // 全树目录名唯一性不变式。
    expect(new Set([...paths.values()]).size).toBe(paths.size);
  });
  it('消歧候选撞上更早出现的同名科目 → 序号探测 x_B(2)(codex review nit)', () => {
    // (x,A)→x;(x_B,Z)原名占用 x_B;(x,B)消歧候选 x_B 已被占用 → x_B(2)。
    const subs: SubjectNode[] = [
      { id: 'a', code: 'A', name: 'x', parentId: null, level: 1, isLeaf: true },
      { id: 'z', code: 'Z', name: 'x_B', parentId: null, level: 1, isLeaf: true },
      { id: 'b', code: 'B', name: 'x', parentId: null, level: 1, isLeaf: true },
    ];
    const paths = buildFolderPaths(subs);
    expect(paths.get('a')).toBe('x');
    expect(paths.get('z')).toBe('x_B');
    expect(paths.get('b')).toBe('x_B(2)');
    expect(new Set([...paths.values()]).size).toBe(paths.size);
  });
  it('消歧后目录名含危险编码也已消毒', () => {
    const subs: SubjectNode[] = [
      { id: 'a', code: 'A1', name: 'x', parentId: null, level: 1, isLeaf: true },
      { id: 'b', code: '../E', name: 'x', parentId: null, level: 1, isLeaf: true },
    ];
    const path = buildFolderPaths(subs).get('b') ?? '';
    expect(path).not.toMatch(/(^|\/)\.\.?(\/|$)/);
  });
});

describe('renderFilename', () => {
  it('默认模板渲染各占位符(无 {original} 时自动补原扩展名)', () => {
    expect(renderFilename('{docNo}_{subject}_{amount}_{completed}_{handler}', ctx)).toBe(
      'BX-2026-0311_设备购置费_1200.00_2026-08-20_张三.pdf',
    );
  });
  it('未知占位符原样保留(字面量)', () => {
    expect(renderFilename('{date}_报销_{original}', ctx)).toBe('2026-08-05_报销_发票.pdf');
  });
  it('所有占位符:handler/subject/status/year;无 {original} 时补原扩展名', () => {
    expect(renderFilename('{handler}_{subject}_{status}_{year}', ctx)).toBe(
      '张三_设备购置费_PAID_2026.pdf',
    );
  });
  it('{original} 不在末尾时补扩展名到结尾', () => {
    expect(renderFilename('{original}_{date}', ctx)).toBe('发票.pdf_2026-08-05.pdf');
  });
  it('已以原扩展名结尾时不重复追加(大小写不敏感)', () => {
    expect(renderFilename('{date}_{amount}_{summary}_{original}', ctx)).toBe(
      '2026-08-05_1200.00_差旅费_发票.pdf',
    );
    const upper: TokenContext = { ...ctx, original: '发票.PDF' };
    expect(renderFilename('{summary}_{original}', upper)).toBe('差旅费_发票.PDF');
  });
  it('结尾是其他扩展名时仍补原扩展名(内容类型以原文件为准)', () => {
    const c: TokenContext = { ...ctx, summary: '扫描件.jpg' };
    expect(renderFilename('{summary}', c)).toBe('扫描件.jpg.pdf');
  });
  it('原文件无扩展名时不凭空追加', () => {
    const c: TokenContext = { ...ctx, original: 'README' };
    expect(renderFilename('{summary}_{handler}', c)).toBe('差旅费_张三');
  });
  it('渲染结果为空(占位值全空)→ 回退原文件名', () => {
    const c: TokenContext = { ...ctx, summary: '' };
    expect(renderFilename('{summary}', c)).toBe('发票.pdf');
  });
  it('渲染后消毒非法字符', () => {
    const c: TokenContext = { ...ctx, summary: 'a/b' };
    expect(renderFilename('{summary}_{original}', c)).toBe('a_b_发票.pdf');
  });
  it('超长文件名(>200)截断保留扩展名', () => {
    const long = 'X'.repeat(300);
    const c: TokenContext = { ...ctx, summary: long };
    const out = renderFilename('{summary}_{original}', c);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.pdf')).toBe(true);
  });
  it('空模板 → 返回 original(兜底)', () => {
    expect(renderFilename('', ctx)).toBe('发票.pdf');
  });
});

describe('renderFilename 可空占位符与空值折叠', () => {
  it('新增占位符:completed/docNo/voucherNo/remark', () => {
    expect(renderFilename('{completed}_{docNo}_{voucherNo}_{remark}_{original}', ctx)).toBe(
      '2026-08-20_BX-2026-0311_记-0123_含往返高铁票_发票.pdf',
    );
  });
  it('单段空:空占位符连同紧邻分段符折叠,不留连续分隔符', () => {
    expect(renderFilename('{date}_{docNo}_{summary}_{original}', { ...ctx, docNo: '' })).toBe(
      '2026-08-05_差旅费_发票.pdf',
    );
  });
  it('连续多段空:逐段折叠不叠加', () => {
    expect(
      renderFilename('{date}_{docNo}_{voucherNo}_{original}', {
        ...ctx,
        docNo: '',
        voucherNo: '',
      }),
    ).toBe('2026-08-05_发票.pdf');
  });
  it('折叠吃后面的分段符优先;末尾空段吃前面的;渲染后仍补原扩展名', () => {
    expect(renderFilename('{date}_{docNo}', { ...ctx, docNo: '' })).toBe('2026-08-05.pdf');
  });
  it('字面文本相邻:吃字面段里的分段符,文本保留', () => {
    expect(renderFilename('附件-{docNo}-费用_{original}', { ...ctx, docNo: '' })).toBe(
      '附件-费用_发票.pdf',
    );
  });
  it('只有可空占位符且全空 → 回退原文件名', () => {
    expect(renderFilename('{docNo}_{original}', { ...ctx, docNo: '' })).toBe('发票.pdf');
    expect(renderFilename('{completed}', { ...ctx, completed: '' })).toBe('发票.pdf');
  });
  it('不吃占位符取值:相邻是占位符(无字面段)时只丢弃空段本身', () => {
    expect(renderFilename('{docNo}{original}', { ...ctx, docNo: '' })).toBe('发票.pdf');
    expect(renderFilename('{date}{docNo}{original}', { ...ctx, docNo: '' })).toBe(
      '2026-08-05发票.pdf',
    );
  });
  it('点不是分段符,不参与折叠;残留首点由消毒去除', () => {
    expect(renderFilename('{docNo}.{original}', { ...ctx, docNo: '' })).toBe('发票.pdf');
  });
  it('分段符包含全角连字符/长破折号/全角空格', () => {
    expect(renderFilename('附件－{docNo}－{original}', { ...ctx, docNo: '' })).toBe(
      '附件－发票.pdf',
    );
  });
  it('未知占位符不受折叠影响,原样保留', () => {
    expect(renderFilename('{docNo}_{unknown}_{original}', { ...ctx, docNo: '' })).toBe(
      '{unknown}_发票.pdf',
    );
  });
});

describe('dedupeName', () => {
  it('首次不追加', () => {
    const used = new Map<string, number>();
    expect(dedupeName('a.pdf', used)).toBe('a.pdf');
    expect(used.get('a.pdf')).toBe(1);
  });
  it('冲突追加 (1)/(2) 在扩展名前', () => {
    const used = new Map<string, number>([['a.pdf', 1]]);
    expect(dedupeName('a.pdf', used)).toBe('a(1).pdf');
    expect(used.get('a.pdf')).toBe(2);
    expect(dedupeName('a.pdf', used)).toBe('a(2).pdf');
  });
  it('无扩展名时追加在末尾', () => {
    const used = new Map<string, number>([['noext', 1]]);
    expect(dedupeName('noext', used)).toBe('noext(1)');
  });
  it('文件夹已有真实 a(1).pdf 时跳过该候选', () => {
    // a.pdf 已存在(count=1),且 a(1).pdf 是真实存在的另一个文件 → 第二次 a.pdf 必须跳到 a(2).pdf
    const used = new Map<string, number>([
      ['a.pdf', 1],
      ['a(1).pdf', 1],
    ]);
    expect(dedupeName('a.pdf', used)).toBe('a(2).pdf');
    expect(used.get('a(1).pdf')).toBe(1);
    expect(used.get('a(2).pdf')).toBe(1);
    expect(used.get('a.pdf')).toBe(2);
  });
  it('三方冲突:连续调用产生 a.pdf/a(1).pdf/a(2).pdf', () => {
    const used = new Map<string, number>();
    expect(dedupeName('a.pdf', used)).toBe('a.pdf');
    expect(dedupeName('a.pdf', used)).toBe('a(1).pdf');
    expect(dedupeName('a.pdf', used)).toBe('a(2).pdf');
    expect(used.get('a.pdf')).toBe(3);
    expect(used.has('a(1).pdf')).toBe(true);
    expect(used.has('a(2).pdf')).toBe(true);
  });
});
