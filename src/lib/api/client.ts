/**
 * 浏览器侧 API 调用封装(V1 mock 鉴权)。
 *
 * 现状:服务端通过 `x-mock-user-id` header 识别当前用户(见 lib/auth/session.ts)。
 * 这里读取 localStorage 中由 dashboard 顶部"模拟用户选择器"写入的 userId,
 * 并以 `x-mock-user-id` header 注入到每次请求中。
 *
 * 后续接入真实鉴权(如 NextAuth)时,只需替换此处的 header 来源,
 * 调用方(apiFetch)签名保持不变。
 */

const MOCK_USER_STORAGE_KEY = 'mock-user-id';

/** 读取当前选中的模拟用户 ID(浏览器环境)。 */
export function getMockUserId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(MOCK_USER_STORAGE_KEY);
}

/** 写入当前选中的模拟用户 ID(由顶部选择器调用)。 */
export function setMockUserId(userId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(MOCK_USER_STORAGE_KEY, userId);
  // 触发同标签页监听者刷新(跨标签页由 storage 事件自然广播)。
  window.dispatchEvent(new Event('mock-user-change'));
}

export const MOCK_USER_STORAGE_KEY_FOR_LISTEN = MOCK_USER_STORAGE_KEY;

/** fetch options:沿用 RequestInit(目前无额外字段,保留类型别名便于后续扩展)。 */
export type ApiFetchOptions = RequestInit;

/**
 * 统一 fetch 封装:相对路径 + 注入 `x-mock-user-id` header + JSON 解析 + 错误规范化。
 * 非 OK 响应抛出 `{ status, message, body }`,调用方可 `try/catch` 取 `e.message`。
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  const mockUserId = getMockUserId();
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (mockUserId) {
    headers.set('x-mock-user-id', mockUserId);
  }

  const res = await fetch(path, { ...init, headers });
  const contentType = res.headers.get('Content-Type') ?? '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);

  if (!res.ok) {
    const message =
      (isJson && body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `请求失败 (${res.status})`) || `请求失败 (${res.status})`;
    const error = new Error(message) as Error & { status: number; body: unknown };
    error.status = res.status;
    error.body = body;
    throw error;
  }

  return body as T;
}
