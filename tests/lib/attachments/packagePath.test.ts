import { describe, it, expect } from 'vitest';

import {
  sanitizeSegment,
  buildFolderPath,
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
  it('普通名保留;去首尾空格与点', () => {
    expect(sanitizeSegment('  正常名称  ')).toBe('正常名称');
    expect(sanitizeSegment('.隐藏.')).toBe('隐藏');
  });
});

describe('buildFolderPath', () => {
  it('从叶到根 walk parentId,每段 code_name', () => {
    expect(buildFolderPath('leaf', subjectById)).toBe('ZJF_直接费/SBF_设备费/SBGZF_设备购置费');
  });
  it('根节点(无 parentId)只返回自身段', () => {
    expect(buildFolderPath('root', subjectById)).toBe('ZJF_直接费');
  });
  it('科目名含非法字符时消毒', () => {
    const subs: SubjectNode[] = [
      { id: 'r', code: 'X', name: 'a/b', parentId: null, level: 1, isLeaf: false },
      { id: 'l', code: 'Y', name: '叶', parentId: 'r', level: 2, isLeaf: true },
    ];
    expect(buildFolderPath('l', new Map(subs.map((s) => [s.id, s])))).toBe('X_a_b/Y_叶');
  });
  it('subjectId 不在 map 中 → 空字符串(防御)', () => {
    expect(buildFolderPath('unknown', subjectById)).toBe('');
  });
});

describe('renderFilename', () => {
  it('默认模板渲染各占位符', () => {
    expect(renderFilename('{date}_{amount}_{summary}_{original}', ctx)).toBe(
      '2026-08-05_1200.00_差旅费_发票.pdf',
    );
  });
  it('未知占位符原样保留(字面量)', () => {
    expect(renderFilename('{date}_报销_{original}', ctx)).toBe('2026-08-05_报销_发票.pdf');
  });
  it('所有占位符:handler/subject/status/year', () => {
    expect(renderFilename('{handler}_{subject}_{status}_{year}', ctx)).toBe(
      '张三_设备购置费_PAID_2026',
    );
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
});
