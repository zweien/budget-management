import { describe, it, expect } from 'vitest';

import { sanitizeReturnTo } from '@/lib/auth/oidc';

describe('sanitizeReturnTo(防开放重定向)', () => {
  it('站内绝对路径原样保留', () => {
    expect(sanitizeReturnTo('/projects')).toBe('/projects');
    expect(sanitizeReturnTo('/projects/123/records?subjectId=a&year=2026')).toBe(
      '/projects/123/records?subjectId=a&year=2026',
    );
  });

  it('空值/缺失回落到 /', () => {
    expect(sanitizeReturnTo(null)).toBe('/');
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
  });

  it('拒绝协议相对与绝对 URL(开放重定向)', () => {
    expect(sanitizeReturnTo('//evil.com')).toBe('/');
    expect(sanitizeReturnTo('https://evil.com')).toBe('/');
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/');
  });

  it('拒绝相对路径与控制字符', () => {
    expect(sanitizeReturnTo('projects')).toBe('/');
    expect(sanitizeReturnTo('/projects\u0000.evil')).toBe('/');
  });
});
