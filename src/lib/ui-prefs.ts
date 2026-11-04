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
// ------------------------------------------------------------

/** 工作台阈值偏好 cookie:{"warn":50,"danger":80}(执行率分级着色线,百分比整数)。 */
export const DASH_THRESHOLDS_COOKIE = 'bm-dash-thresholds';

/** 执行率分级线(百分比整数):低于 warn 预警色;warn~danger 之间警示色;高于 danger 正常色。 */
export interface DashThresholds {
  warn: number;
  danger: number;
}

export const DEFAULT_DASH_THRESHOLDS: DashThresholds = { warn: 50, danger: 80 };

/** 解析阈值 cookie;损坏/越界回落 null(调用方用默认值)。 */
export function parseDashThresholds(raw: string | undefined | null): DashThresholds | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DashThresholds>;
    const warn = Number(parsed.warn);
    const danger = Number(parsed.danger);
    if (
      Number.isInteger(warn) &&
      Number.isInteger(danger) &&
      warn >= 0 &&
      warn < 100 &&
      danger > 0 &&
      danger <= 100 &&
      warn < danger
    ) {
      return { warn, danger };
    }
    return null;
  } catch {
    return null;
  }
}

/** 读阈值偏好(仅客户端);无/损坏回落默认。 */
export function readDashThresholds(): DashThresholds {
  if (typeof document === 'undefined') return DEFAULT_DASH_THRESHOLDS;
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${DASH_THRESHOLDS_COOKIE}=`))
    ?.slice(DASH_THRESHOLDS_COOKIE.length + 1);
  return parseDashThresholds(raw ? decodeURIComponent(raw) : null) ?? DEFAULT_DASH_THRESHOLDS;
}

/** 写阈值偏好(仅客户端,max-age 一年)。 */
export function writeDashThresholds(thresholds: DashThresholds): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${DASH_THRESHOLDS_COOKIE}=${encodeURIComponent(
    JSON.stringify(thresholds),
  )}; path=/; max-age=31536000; samesite=lax`;
}
