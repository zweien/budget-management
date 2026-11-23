import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import { parseChangelog } from '@/lib/changelog';

describe('parseChangelog', () => {
  it('解析多版本与小节(Keep a Changelog)', () => {
    const md = [
      '# 更新日志',
      '',
      '前言说明,跳过。',
      '',
      '## [0.2.0] - 2026-08-05',
      '',
      '### 新增',
      '',
      '- 侧边栏可收缩',
      '- 新增「更新日志」页面',
      '',
      '### 修复',
      '',
      '- 脏状态导航绕过拦截',
      '',
      '## [0.1.0] - 2026-07-29',
      '',
      '### 新增',
      '',
      '- 初始版本',
      '',
    ].join('\n');

    const releases = parseChangelog(md);
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({ version: '0.2.0', date: '2026-08-05' });
    expect(releases[0].sections).toHaveLength(2);
    expect(releases[0].sections[0]).toEqual({
      title: '新增',
      items: ['侧边栏可收缩', '新增「更新日志」页面'],
    });
    expect(releases[1].sections[0].items).toEqual(['初始版本']);
  });

  it('保留条目内的行内标记原文(由页面渲染 code/bold/link)', () => {
    const md =
      '## [1.0.0] - 2026-01-01\n\n### 变更\n\n- 详见 `npm version` 与 **重要** [文档](https://a.b)\n';
    expect(parseChangelog(md)[0].sections[0].items[0]).toBe(
      '详见 `npm version` 与 **重要** [文档](https://a.b)',
    );
  });

  it('无版本节时返回空数组', () => {
    expect(parseChangelog('# 只有标题\n\n一些说明。\n')).toEqual([]);
  });

  it('小节缺失时条目归入「其他」', () => {
    const md = '## [1.0.0] - 2026-01-01\n\n- 裸条目\n';
    expect(parseChangelog(md)[0].sections[0]).toEqual({ title: '其他', items: ['裸条目'] });
  });

  it('版本节外的条目行被忽略(前言区)', () => {
    const md = '# 更新日志\n\n- 前言里的列表项\n\n## [1.0.0] - 2026-01-01\n';
    const releases = parseChangelog(md);
    expect(releases).toHaveLength(1);
    expect(releases[0].sections).toEqual([]);
  });

  it('未发布版本(## [Unreleased],无日期)的条目不进入解析结果', () => {
    const md = [
      '# 更新日志',
      '',
      '## [Unreleased]',
      '',
      '### 新增',
      '',
      '- 尚未发布的功能',
      '',
      '## [1.0.0] - 2026-01-01',
      '',
      '### 新增',
      '',
      '- 已发布的功能',
      '',
    ].join('\n');
    const releases = parseChangelog(md);
    expect(releases.map((r) => r.version)).toEqual(['1.0.0']);
    expect(releases[0].sections[0].items).toEqual(['已发布的功能']);
  });

  it('真实 CHANGELOG.md:/changelog 页运行期直接读该文件,Unreleased 节的内容不得外显', async () => {
    // 生产实例就读仓库工作区的这个文件:未发布条目写进 Unreleased 后,页面必须仍然只显示已发布版本。
    const text = await readFile(path.resolve(process.cwd(), 'CHANGELOG.md'), 'utf8');
    const releases = parseChangelog(text);
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(release.version).not.toBe('Unreleased');
    }
  });
});
