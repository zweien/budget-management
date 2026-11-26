import type { VisibilityState } from '@tanstack/react-table';

/**
 * UI 偏好(cookie 持久化,服务端可读取 → 首屏无闪烁、无水合不一致)。
 * 服务端(next/headers cookies)与客户端(document.cookie)共用此键。
 */
export const SIDEBAR_COLLAPSED_COOKIE = 'bm-sidebar-collapsed';

/** 列显隐偏好 cookie:值为 JSON,键=偏好 key(如 ui.records.columns),值=TanStack VisibilityState。 */
export const COLUMN_PREFS_COOKIE = 'bm-column-prefs';

/** 解析列偏好 cookie 值(原始 JSON 串);损坏/为空返回空对象。 */
export function parseColumnPrefs(raw: string | undefined | null): Record<string, VisibilityState> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, VisibilityState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 序列化列偏好 cookie 值。 */
export function serializeColumnPrefs(prefs: Record<string, VisibilityState>): string {
  return JSON.stringify(prefs);
}

/** 从 document.cookie 读出某 key 的列显隐(仅客户端)。 */
export function readColumnPrefFromDocument(key: string): VisibilityState | undefined {
  if (typeof document === 'undefined') return undefined;
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${COLUMN_PREFS_COOKIE}=`))
    ?.slice(COLUMN_PREFS_COOKIE.length + 1);
  if (!raw) return undefined;
  return parseColumnPrefs(decodeURIComponent(raw))[key];
}

/** 把某 key 的列显隐写进偏好 cookie(仅客户端;整键重写,max-age 一年)。 */
export function writeColumnPrefToDocument(key: string, visibility: VisibilityState): void {
  if (typeof document === 'undefined') return;
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${COLUMN_PREFS_COOKIE}=`))
    ?.slice(COLUMN_PREFS_COOKIE.length + 1);
  const prefs = parseColumnPrefs(raw ? decodeURIComponent(raw) : undefined);
  prefs[key] = visibility;
  document.cookie = `${COLUMN_PREFS_COOKIE}=${encodeURIComponent(serializeColumnPrefs(prefs))}; path=/; max-age=31536000; samesite=lax`;
}

// ------------------------------------------------------------
// 工作台管理决策阈值偏好(cookie 持久化,客户端读写;工作台数据客户端拉取,无 SSR 闪烁)。
// 默认值来自系统设置(CONTEXT.md「系统设置」):个人调过以 cookie 为准,没调过跟随系统默认。
// ------------------------------------------------------------

/** 工作台阈值偏好 cookie:{"warn":50,"danger":80}(执行率分级着色线,百分比整数)。 */
export const DASH_THRESHOLDS_COOKIE = 'bm-dash-thresholds';

/** 执行率分级线(百分比整数):低于 warn 预警色;warn~danger 之间警示色;高于 danger 正常色。 */
export interface DashThresholds {
  warn: number;
  danger: number;
}

/** 系统设置不可用时的兜底默认(与系统设置的出厂默认同值)。 */
export const DEFAULT_DASH_THRESHOLDS: DashThresholds = { warn: 50, danger: 80 };

/** 分级线取值域:0~100 的整数,且预警线 < 达标线。 */
export function isValidDashThresholds(value: unknown): value is DashThresholds {
  if (typeof value !== 'object' || value === null) return false;
  const warn = Number((value as { warn?: unknown }).warn);
  const danger = Number((value as { danger?: unknown }).danger);
  return (
    Number.isInteger(warn) &&
    Number.isInteger(danger) &&
    warn >= 0 &&
    warn < 100 &&
    danger > 0 &&
    danger <= 100 &&
    warn < danger
  );
}

/** 解析阈值 cookie;损坏/越界回落 null(调用方用默认值)。 */
export function parseDashThresholds(raw: string | undefined | null): DashThresholds | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidDashThresholds(parsed) ? { warn: parsed.warn, danger: parsed.danger } : null;
  } catch {
    return null;
  }
}

/** 读阈值偏好(仅客户端):有合法的个人偏好用个人值,否则用系统默认(fallback)。 */
export function readDashThresholds(
  fallback: DashThresholds = DEFAULT_DASH_THRESHOLDS,
): DashThresholds {
  if (typeof document === 'undefined') return fallback;
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${DASH_THRESHOLDS_COOKIE}=`))
    ?.slice(DASH_THRESHOLDS_COOKIE.length + 1);
  return parseDashThresholds(raw ? decodeURIComponent(raw) : null) ?? fallback;
}

/** 写阈值偏好(仅客户端,max-age 一年)。 */
export function writeDashThresholds(thresholds: DashThresholds): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${DASH_THRESHOLDS_COOKIE}=${encodeURIComponent(
    JSON.stringify(thresholds),
  )}; path=/; max-age=31536000; samesite=lax`;
}

/** 清除阈值个人偏好,回到跟随系统默认(「恢复默认」;区别于把默认值写死进偏好)。 */
export function clearDashThresholds(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${DASH_THRESHOLDS_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

// ------------------------------------------------------------
// 项目列表「只看我的项目」偏好(cookie 持久化,客户端读写;项目管理页用)。
// 默认关(显示全部);打开才落 cookie,关闭即清除——「未作出」与「关」同义。
// ------------------------------------------------------------

/** 「只看我的项目」偏好 cookie:值为 '1' = 只显示自己是成员的项目;不存在 = 关(默认)。 */
export const PROJECTS_ONLY_MINE_COOKIE = 'bm-projects-only-mine';

/** 读「只看我的项目」偏好(仅客户端;无文档对象或 cookie 不存在/值不为 '1' = false)。 */
export function readProjectsOnlyMine(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split('; ').includes(`${PROJECTS_ONLY_MINE_COOKIE}=1`);
}

/** 写「只看我的项目」偏好(仅客户端,max-age 一年);关闭时清除 cookie,回到默认。 */
export function writeProjectsOnlyMine(onlyMine: boolean): void {
  if (typeof document === 'undefined') return;
  document.cookie = onlyMine
    ? `${PROJECTS_ONLY_MINE_COOKIE}=1; path=/; max-age=31536000; samesite=lax`
    : `${PROJECTS_ONLY_MINE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
