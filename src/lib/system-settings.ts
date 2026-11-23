import { z } from 'zod';

import { DEFAULT_DASH_THRESHOLDS, type DashThresholds } from '@/lib/ui-prefs';

/**
 * 系统设置(ADR 0004;CONTEXT.md「系统设置」)的单一事实源:出厂默认、各键的取值与校验、
 * 标志回退规则。纯函数、无 IO——服务端用它校验写入,客户端用它回落默认与解析标志,
 * 两端对「有哪些设置项」只有这一处认知。新增设置项 = 在此加一个键,不动表结构。
 */

/** 主题取值,与 next-themes 一致:system = 跟随操作系统。 */
export const THEME_VALUES = ['light', 'dark', 'system'] as const;
export type ThemeValue = (typeof THEME_VALUES)[number];

/** 台账口径(CONTEXT.md「台账口径」):annual = 按年度;total = 按总预算(跨年度)。 */
export const LEDGER_BASIS_VALUES = ['annual', 'total'] as const;
export type LedgerBasis = (typeof LEDGER_BASIS_VALUES)[number];

/** 台账默认年度:current = 当前年度;latest = 该项目最近有预算的年度(无预算回退当前年度)。 */
export const LEDGER_YEAR_VALUES = ['current', 'latest'] as const;
export type LedgerYearMode = (typeof LEDGER_YEAR_VALUES)[number];

/** 系统标志的三个上传位(CONTEXT.md「系统标志」)。 */
export const LOGO_SLOTS = ['standard', 'dark', 'compact'] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];

export const THEME_LABELS: Record<ThemeValue, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

export const LEDGER_BASIS_LABELS: Record<LedgerBasis, string> = {
  annual: '按年度',
  total: '按总预算(跨年度)',
};

export const LEDGER_YEAR_LABELS: Record<LedgerYearMode, string> = {
  current: '当前年度',
  latest: '最近有预算的年度',
};

export const LOGO_SLOT_LABELS: Record<LogoSlot, string> = {
  standard: '标准版',
  dark: '深色主题版',
  compact: '窄栏图标版',
};

/** 工作台执行率分级线(与 ui-prefs 的个人偏好 cookie 同一取值域):预警线低于达标线。 */
export const dashThresholdsSchema = z
  .object({
    warn: z
      .number()
      .int()
      .min(0, { message: '预警线须为 0~99 的整数' })
      .max(99, { message: '预警线须为 0~99 的整数' }),
    danger: z
      .number()
      .int()
      .min(1, { message: '达标线须为 1~100 的整数' })
      .max(100, { message: '达标线须为 1~100 的整数' }),
  })
  .refine((t) => t.warn < t.danger, {
    message: '预警线须小于达标线',
    path: ['warn'],
  }) satisfies z.ZodType<DashThresholds>;

/**
 * 可空文本:trim 后计长;空串与 null 等价(= 不显示)。单行的拒绝换行,
 * 页脚/登录提示挤进多行会撑坏版式。
 */
function nullableText(max: number, label: string, opts: { multiline: boolean }) {
  const bounded = z
    .string()
    .trim()
    .max(max, { message: `${label}不能超过 ${max} 字` });
  const schema = opts.multiline
    ? bounded
    : bounded.refine((v) => !/[\r\n]/.test(v), { message: `${label}须为单行文本` });
  return schema.transform((v) => (v === '' ? null : v)).nullable();
}

const invalidEnum = (label: string) => ({ errorMap: () => ({ message: `${label}取值无效` }) });

/** 各设置键的 schema(键名即库内 JSON 的键名)。 */
export const systemSettingFields = {
  title: z
    .string()
    .trim()
    .min(1, { message: '系统标题不能为空' })
    .max(30, { message: '系统标题不能超过 30 字' }),
  subtitle: nullableText(60, '副标题', { multiline: false }),
  loginNotice: nullableText(200, '登录页提示', { multiline: false }),
  aboutIntro: nullableText(1000, '关于页系统简介', { multiline: true }),
  footerText: nullableText(100, '页脚文字', { multiline: false }),
  defaultTheme: z.enum(THEME_VALUES, invalidEnum('默认主题')),
  ledgerBasis: z.enum(LEDGER_BASIS_VALUES, invalidEnum('台账默认口径')),
  ledgerYear: z.enum(LEDGER_YEAR_VALUES, invalidEnum('台账默认年度')),
  dashThresholds: dashThresholdsSchema,
  sidebarCollapsed: z.boolean({ invalid_type_error: '侧边栏默认折叠须为布尔值' }),
} as const satisfies Record<string, z.ZodTypeAny>;

/** 全量系统设置(合并出厂默认之后的生效值)。 */
export const systemSettingsSchema = z.object(systemSettingFields).strict();
export type SystemSettings = z.infer<typeof systemSettingsSchema>;

/** 一次保存提交的键(缺省的键保持不变);未知键一律拒绝。 */
export const systemSettingsPatchSchema = systemSettingsSchema.partial().strict();
export type SystemSettingsPatch = z.input<typeof systemSettingsPatchSchema>;

/** 「关于」页系统简介的出厂文案(纯文本,换行保留)。 */
const DEFAULT_ABOUT_INTRO =
  '面向科研经费的全生命周期预算管理:从初始预算编制与审批,到业务记录登记、结算单导入、预算调整,再到执行台账与统计分析。年度预算回归「当年计划」定位,支持以总预算剩余额度为锚的余额式编制;所有敏感操作(审批、作废、权限变更)均留审计痕迹。';

/** 出厂默认:全部等于引入系统设置之前的行为,不改设置就没有任何变化。 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  title: '预算管理系统',
  subtitle: '科研项目预算管理',
  loginNotice: '首次登录将自动创建本地账号(普通用户),权限由管理员分配',
  aboutIntro: DEFAULT_ABOUT_INTRO,
  footerText: null,
  defaultTheme: 'system',
  ledgerBasis: 'annual',
  ledgerYear: 'current',
  dashThresholds: DEFAULT_DASH_THRESHOLDS,
  sidebarCollapsed: false,
};

/** 标志的对外元数据(url 带版本号,可长缓存;字节本身不入此处)。 */
export interface LogoMeta {
  url: string;
  contentType: string;
  sizeBytes: number;
}

export type LogoMap = Record<LogoSlot, LogoMeta | null>;

/** 对外发布的系统设置:生效值 + 标志元数据。 */
export interface SystemSettingsSnapshot extends SystemSettings {
  logos: LogoMap;
}

export const EMPTY_LOGO_MAP: LogoMap = { standard: null, dark: null, compact: null };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把库里的稀疏 JSON 合并到出厂默认。未知键忽略、单个坏键只丢该键——
 * 一行里的坏数据(或版本升级后的遗留键)不该把管理员的其余设置一并打掉。
 */
export function mergeSystemSettings(stored: unknown): SystemSettings {
  const out: SystemSettings = {
    ...DEFAULT_SYSTEM_SETTINGS,
    dashThresholds: { ...DEFAULT_SYSTEM_SETTINGS.dashThresholds },
  };
  if (!isPlainObject(stored)) return out;
  const fields = systemSettingFields as Record<string, z.ZodTypeAny>;
  for (const [key, value] of Object.entries(stored)) {
    const schema = fields[key];
    if (!schema) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      (out as unknown as Record<string, unknown>)[key] = parsed.data;
    }
  }
  return out;
}

/**
 * 标志回退规则(CONTEXT.md「系统标志」):深色主题下有深色版用深色版,否则用标准版;
 * 窄栏下有窄栏图标版用它,否则把当前主题的版本整体缩小。没有标准版即未设置自定义标志。
 */
export function resolveLogoSrc(
  logos: Partial<Record<LogoSlot, string | Pick<LogoMeta, 'url'> | null>>,
  opts: { compact: boolean; dark: boolean },
): string | null {
  const pick = (slot: LogoSlot): string | null => {
    const v = logos[slot];
    if (!v) return null;
    return typeof v === 'string' ? v : v.url;
  };
  const themed = (opts.dark && pick('dark')) || pick('standard');
  return (opts.compact && pick('compact')) || themed || null;
}
