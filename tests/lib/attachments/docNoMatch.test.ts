import { describe, it, expect } from 'vitest';

import { matchDocNo } from '@/lib/attachments/docNoMatch';

/**
 * 批量附件导入的单据编号前缀匹配规则(CONTEXT.md「批量附件导入」):
 * 文件名以某 docNo 开头、且其后一字符为非 ASCII 字母数字(分隔符/中文/结尾皆可)即命中;
 * 多条命中取最长;大小写敏感、不做折叠。
 */
describe('matchDocNo', () => {
  // 真实文件名样例(用户提供):前缀 + `_序号_说明 (n).pdf`。
  it('真实样例:`_` 分隔 → 命中完整编号', () => {
    const docNo = 'TYBX26189195387403373';
    expect(matchDocNo(`${docNo}_01_徐维乐-3722 (1).pdf`, [docNo])).toBe(docNo);
    expect(matchDocNo(`${docNo}_02_徐维乐补充(1).pdf`, [docNo])).toBe(docNo);
  });

  it('边界=结尾:文件名去掉扩展名恰好是编号(含无扩展名)', () => {
    expect(matchDocNo('TYBX123', ['TYBX123'])).toBe('TYBX123');
    expect(matchDocNo('TYBX123.pdf', ['TYBX123'])).toBe('TYBX123');
  });

  it('边界=非 ASCII 字母数字:中文紧贴编号也算边界', () => {
    expect(matchDocNo('TYBX123发票.pdf', ['TYBX123'])).toBe('TYBX123');
    expect(matchDocNo('TYBX123 (1).pdf', ['TYBX123'])).toBe('TYBX123');
  });

  it('编号后紧跟 ASCII 字母数字 → 不命中(防 BX1 误中 BX12)', () => {
    expect(matchDocNo('TYBX123x.pdf', ['TYBX123'])).toBeNull();
    expect(matchDocNo('BX12abc.pdf', ['BX1', 'BX12'])).toBeNull();
  });

  it('多条命中取最长', () => {
    expect(matchDocNo('TYBX1_2 报销.pdf', ['TYBX1', 'TYBX1_2'])).toBe('TYBX1_2');
    expect(matchDocNo('TYBX1_2.pdf', ['TYBX1', 'TYBX1_2'])).toBe('TYBX1_2');
  });

  it('大小写敏感,不做折叠', () => {
    expect(matchDocNo('tybx123_1.pdf', ['TYBX123'])).toBeNull();
  });

  it('无候选 / 编号比文件名长 / 空编号 → 不命中', () => {
    expect(matchDocNo('任何文件.pdf', [])).toBeNull();
    expect(matchDocNo('TYBX1.pdf', ['TYBX123456789'])).toBeNull();
    expect(matchDocNo('随便.pdf', ['', 'TYBX123'])).toBeNull();
  });
});
