import { describe, it, expect } from 'vitest';

import {
  DEFAULT_SYSTEM_SETTINGS,
  LOGO_SLOTS,
  mergeSystemSettings,
  resolveLogoSrc,
  systemSettingsPatchSchema,
} from '@/lib/system-settings';

describe('system-settings(纯函数:出厂默认 / 合并 / 校验 / 标志回退)', () => {
  it('出厂默认等于引入系统设置之前的行为', () => {
    expect(DEFAULT_SYSTEM_SETTINGS).toEqual({
      title: '预算管理系统',
      subtitle: '科研项目预算管理',
      loginNotice: '首次登录将自动创建本地账号(普通用户),权限由管理员分配',
      aboutIntro: expect.stringContaining('面向科研经费的全生命周期预算管理'),
      footerText: null,
      defaultTheme: 'system',
      ledgerBasis: 'annual',
      ledgerYear: 'current',
      dashThresholds: { warn: 50, danger: 80 },
      sidebarCollapsed: false,
    });
  });

  describe('mergeSystemSettings(稀疏 JSON 合并到出厂默认)', () => {
    it('没有行 / 非对象 = 全部出厂默认', () => {
      expect(mergeSystemSettings(null)).toEqual(DEFAULT_SYSTEM_SETTINGS);
      expect(mergeSystemSettings(undefined)).toEqual(DEFAULT_SYSTEM_SETTINGS);
      expect(mergeSystemSettings('garbage')).toEqual(DEFAULT_SYSTEM_SETTINGS);
      expect(mergeSystemSettings([1, 2])).toEqual(DEFAULT_SYSTEM_SETTINGS);
    });

    it('只覆盖显式保存过的键,其余保持默认', () => {
      const merged = mergeSystemSettings({ title: '经费管理平台', defaultTheme: 'dark' });
      expect(merged.title).toBe('经费管理平台');
      expect(merged.defaultTheme).toBe('dark');
      expect(merged.subtitle).toBe(DEFAULT_SYSTEM_SETTINGS.subtitle);
      expect(merged.ledgerBasis).toBe('annual');
    });

    it('可空文本存 null 即「有意清空」,覆盖出厂默认文案', () => {
      const merged = mergeSystemSettings({ subtitle: null, footerText: '© 某大学' });
      expect(merged.subtitle).toBeNull();
      expect(merged.footerText).toBe('© 某大学');
      expect(merged.loginNotice).toBe(DEFAULT_SYSTEM_SETTINGS.loginNotice);
    });

    it('未知键忽略;单个坏键只丢该键,不影响其余设置', () => {
      const merged = mergeSystemSettings({
        legacyKey: 'x',
        title: '新标题',
        defaultTheme: 'neon',
        dashThresholds: { warn: 90, danger: 80 },
        sidebarCollapsed: 'yes',
        ledgerBasis: 'total',
      });
      expect(merged).not.toHaveProperty('legacyKey');
      expect(merged.title).toBe('新标题');
      expect(merged.ledgerBasis).toBe('total');
      expect(merged.defaultTheme).toBe('system');
      expect(merged.dashThresholds).toEqual({ warn: 50, danger: 80 });
      expect(merged.sidebarCollapsed).toBe(false);
    });

    it('非空字段被存成 null 时回落默认;每次合并返回独立的嵌套对象', () => {
      const a = mergeSystemSettings({ title: null });
      expect(a.title).toBe(DEFAULT_SYSTEM_SETTINGS.title);
      const b = mergeSystemSettings({});
      expect(b.dashThresholds).not.toBe(a.dashThresholds);
      b.dashThresholds.warn = 1;
      expect(DEFAULT_SYSTEM_SETTINGS.dashThresholds.warn).toBe(50);
    });
  });

  describe('systemSettingsPatchSchema(一次保存提交的键)', () => {
    const ok = (input: unknown) => systemSettingsPatchSchema.safeParse(input).success;

    it('全部键可省略;省略的键不参与合并', () => {
      expect(systemSettingsPatchSchema.parse({})).toEqual({});
      expect(ok({ title: '新标题' })).toBe(true);
    });

    it('未知键一律拒绝', () => {
      expect(ok({ nope: 1 })).toBe(false);
      expect(ok({ logos: {} })).toBe(false);
      expect(ok([])).toBe(false);
      expect(ok(null)).toBe(false);
    });

    it('系统标题:trim 后必填、≤30 字', () => {
      const parse = (title: string) => systemSettingsPatchSchema.safeParse({ title });
      expect(parse('  科研经费管理  ')).toMatchObject({
        success: true,
        data: { title: '科研经费管理' },
      });
      expect(parse('   ')).toMatchObject({ success: false });
      expect(parse('')).toMatchObject({ success: false });
      expect(parse('标'.repeat(30))).toMatchObject({ success: true });
      expect(parse('标'.repeat(31))).toMatchObject({ success: false });
    });

    it('可空文本:空串与 null 等价、超长拒绝;单行的拒绝换行,多行的保留换行', () => {
      const parse = (input: unknown) => systemSettingsPatchSchema.safeParse(input);
      expect(parse({ subtitle: '  ' })).toMatchObject({ success: true, data: { subtitle: null } });
      expect(parse({ subtitle: null })).toMatchObject({ success: true, data: { subtitle: null } });
      expect(parse({ subtitle: '副'.repeat(61) })).toMatchObject({ success: false });
      expect(parse({ loginNotice: '第一行\n第二行' })).toMatchObject({ success: false });
      expect(parse({ footerText: 'a\r\nb' })).toMatchObject({ success: false });
      expect(parse({ aboutIntro: '第一行\n第二行' })).toMatchObject({
        success: true,
        data: { aboutIntro: '第一行\n第二行' },
      });
      expect(parse({ aboutIntro: '字'.repeat(1001) })).toMatchObject({ success: false });
    });

    it('枚举键只接受既定取值', () => {
      for (const defaultTheme of ['light', 'dark', 'system']) {
        expect(ok({ defaultTheme })).toBe(true);
      }
      expect(ok({ defaultTheme: 'neon' })).toBe(false);
      expect(ok({ ledgerBasis: 'total' })).toBe(true);
      expect(ok({ ledgerBasis: 'yearly' })).toBe(false);
      expect(ok({ ledgerYear: 'latest' })).toBe(true);
      expect(ok({ ledgerYear: 2026 })).toBe(false);
      expect(ok({ sidebarCollapsed: true })).toBe(true);
      expect(ok({ sidebarCollapsed: 'true' })).toBe(false);
    });

    it('分级线:0~100 的整数且预警线 < 达标线', () => {
      expect(ok({ dashThresholds: { warn: 30, danger: 60 } })).toBe(true);
      expect(ok({ dashThresholds: { warn: 0, danger: 100 } })).toBe(true);
      expect(ok({ dashThresholds: { warn: 60, danger: 60 } })).toBe(false);
      expect(ok({ dashThresholds: { warn: 80, danger: 50 } })).toBe(false);
      expect(ok({ dashThresholds: { warn: -1, danger: 50 } })).toBe(false);
      expect(ok({ dashThresholds: { warn: 10, danger: 101 } })).toBe(false);
      expect(ok({ dashThresholds: { warn: 10.5, danger: 50 } })).toBe(false);
      expect(ok({ dashThresholds: { warn: 10 } })).toBe(false);
    });

    it('报错文案是中文且带字段路径(与 withRoute 的 422 文案同款)', () => {
      const result = systemSettingsPatchSchema.safeParse({ title: '标'.repeat(31) });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(['title']);
        expect(result.error.issues[0]?.message).toBe('系统标题不能超过 30 字');
      }
    });
  });

  describe('resolveLogoSrc(标志回退规则)', () => {
    const S = '/logo-standard.png';
    const D = '/logo-dark.png';
    const C = '/logo-compact.png';

    it('未设置任何标志 → null(调用方回落内置标志)', () => {
      expect(resolveLogoSrc({}, { compact: false, dark: false })).toBeNull();
      expect(resolveLogoSrc({}, { compact: true, dark: true })).toBeNull();
      expect(resolveLogoSrc({ dark: D }, { compact: true, dark: true })).toBe(D);
    });

    it('深色主题:有深色版用深色版,否则用标准版', () => {
      expect(resolveLogoSrc({ standard: S }, { compact: false, dark: true })).toBe(S);
      expect(resolveLogoSrc({ standard: S, dark: D }, { compact: false, dark: true })).toBe(D);
      expect(resolveLogoSrc({ standard: S, dark: D }, { compact: false, dark: false })).toBe(S);
    });

    it('窄栏:有窄栏图标版用它,否则把当前主题的版本整体缩小', () => {
      expect(resolveLogoSrc({ standard: S }, { compact: true, dark: false })).toBe(S);
      expect(resolveLogoSrc({ standard: S, dark: D }, { compact: true, dark: true })).toBe(D);
      expect(
        resolveLogoSrc({ standard: S, dark: D, compact: C }, { compact: true, dark: true }),
      ).toBe(C);
    });

    it('接受带 url 的元数据对象与字符串两种来源', () => {
      expect(resolveLogoSrc({ standard: { url: S } }, { compact: false, dark: false })).toBe(S);
      expect(LOGO_SLOTS).toEqual(['standard', 'dark', 'compact']);
    });
  });
});
