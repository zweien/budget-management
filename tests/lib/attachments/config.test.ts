import { describe, it, expect } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES_DEFAULT,
  validateAttachment,
  humanFileSize,
} from '@/lib/attachments/config';

const MAX = MAX_ATTACHMENT_BYTES_DEFAULT; // 50MB

describe('validateAttachment', () => {
  it('合法 PDF 通过', () => {
    const r = validateAttachment({ name: '发票.pdf', type: 'application/pdf', size: 1024 }, MAX);
    expect(r.ok).toBe(true);
  });

  it('合法图片通过(jpeg)', () => {
    const r = validateAttachment({ name: 'a.jpg', type: 'image/jpeg', size: 100 }, MAX);
    expect(r.ok).toBe(true);
  });

  it('合法 docx 通过', () => {
    const r = validateAttachment(
      {
        name: '明细.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 100,
      },
      MAX,
    );
    expect(r.ok).toBe(true);
  });

  it('超 50MB → ok:false status:413', () => {
    const r = validateAttachment({ name: 'big.pdf', type: 'application/pdf', size: MAX + 1 }, MAX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it('非白名单 MIME → ok:false status:415', () => {
    const r = validateAttachment(
      { name: 'a.exe', type: 'application/x-msdownload', size: 10 },
      MAX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it('MIME 白名单但扩展名不符 → ok:false status:415(防伪造)', () => {
    const r = validateAttachment(
      { name: 'evil.pdf', type: 'application/x-msdownload', size: 10 },
      MAX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it('扩展名白名单但 MIME 不符 → ok:false status:415', () => {
    const r = validateAttachment({ name: 'a.pdf', type: 'image/jpeg', size: 10 }, MAX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it('无扩展名 → ok:false status:415', () => {
    const r = validateAttachment({ name: 'noext', type: 'application/pdf', size: 10 }, MAX);
    expect(r.ok).toBe(false);
  });
});

describe('humanFileSize', () => {
  it('字节级显示 B', () => expect(humanFileSize(500)).toBe('500 B'));
  it('KB 一位小数', () => expect(humanFileSize(1024)).toBe('1.0 KB'));
  it('MB 一位小数', () => expect(humanFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB'));
});
