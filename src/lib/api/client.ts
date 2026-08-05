/**
 * 浏览器侧 API 调用封装(V1 mock 鉴权)。
 *
 * 现状:服务端通过 `x-mock-user-id` header 识别当前用户(见 lib/auth/session.ts)。
 * 这里读取 localStorage 中由 dashboard 顶部"模拟用户选择器"写入的 userId,
 * 并以 `x-mock-user-id` header 注入到每次请求中。
 *
 * 后续接入真实鉴权(如 NextAuth)时,只需替换此处的 header 来源,
 * 调用方(apiFetch)签名保持不变。
 *
 * Bootstrap 竞态说明:数据页(`useEffect` 发起的 apiFetch)与顶部
 * `MockUserSelector` 的异步 bootstrap 并发执行。若 apiFetch 在选择器写入
 * localStorage 前就触发,会无 header 请求 → 服务端 401。
 * 解法:apiFetch 不再直接读 localStorage,而是先 `await bootstrapMockUser()`
 * 确保已有可用身份(必要时自动拉取 /api/users 并写入),再发请求。
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
  // 选择器写入新身份后,下次 apiFetch 应立即使用,无需重新 bootstrap。
  bootstrapPromise = null;
}

export const MOCK_USER_STORAGE_KEY_FOR_LISTEN = MOCK_USER_STORAGE_KEY;

/** /api/users bootstrap 返回的用户最小字段。 */
interface BootstrapUser {
  id: string;
  name: string;
  role: string;
}

/**
 * 进行中的 bootstrap promise(模块级,用于并发去重)。
 * - null:无进行中的 bootstrap(已就绪或未启动)。
 * - Promise:某次 bootstrap 正在跑,后续调用 await 同一个。
 * 选择器写入身份后会置为 null,确保新身份立刻生效。
 */
let bootstrapPromise: Promise<string | null> | null = null;

/**
 * 确保存在可用的 mock 用户身份,返回其 id。
 *
 * - 已有 localStorage 身份:直接返回(无需网络)。
 * - 无身份:发起一次 `/api/users` 请求(**不经过 apiFetch、不带 header**,
 *   服务端会放行返回种子 ADMIN 列表),选中第一个 ADMIN
 *   (回退第一个),写入 localStorage 后返回。
 * - SSO 模式(/api/users 返回 401):返回 null——不注入 mock header,
 *   请求仅凭浏览器 cookie 会话鉴权。
 * - 并发调用复用同一个 in-flight promise(去重),避免重复 bootstrap。
 *
 * SSR(无 window)环境:返回 null,由调用方决定降级行为(apiFetch 不写 header)。
 * Bootstrap 失败时:reject 并清空 in-flight 缓存,使后续调用可重试。
 */
export function bootstrapMockUser(): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);

  const stored = getMockUserId();
  if (stored) return Promise.resolve(stored);

  if (bootstrapPromise) return bootstrapPromise;

  const inflight = (async (): Promise<string | null> => {
    // 注意:此处必须用裸 fetch,不能走 apiFetch(否则递归 bootstrap)。
    // 不带 x-mock-user-id → 服务端走"未登录 bootstrap"分支,返回种子 admin。
    const res = await fetch('/api/users', { headers: { Accept: 'application/json' } });
    // SSO 模式(/api/users 401):无 mock bootstrap,返回 null → 请求仅靠 cookie 会话。
    if (res.status === 401) return null;
    const list: BootstrapUser[] | null = res.ok ? await res.json().catch(() => null) : null;
    if (!res.ok || !Array.isArray(list) || list.length === 0) {
      throw new Error('无法加载模拟用户列表(bootstrap 失败)');
    }
    const admin = list.find((u) => u.role === 'ADMIN') ?? list[0];
    setMockUserId(admin.id);
    return admin.id;
  })()
    // 成功后保留缓存到 resolve:bootstrapPromise 在此 then 内仍指向本次,
    // 之后置空,让 getMockUserId() 成为后续快速路径。
    .then((id) => {
      bootstrapPromise = null;
      return id;
    })
    .catch((err) => {
      // 失败:清空缓存以允许重试,向上抛错。
      bootstrapPromise = null;
      throw err;
    });

  bootstrapPromise = inflight;
  return inflight;
}

/** fetch options:沿用 RequestInit(目前无额外字段,保留类型别名便于后续扩展)。 */
export type ApiFetchOptions = RequestInit;

/**
 * 下载文件(xlsx 等二进制响应,§10.5 导出场景)。
 *
 * 与 `apiFetch` 的差异:响应是二进制 blob(非 JSON),因此不能走 apiFetch 的
 * JSON 解析路径。这里仍以同样的方式注入 `x-mock-user-id` header(服务端鉴权
 * 需要),拿到 blob 后用 `URL.createObjectURL` + 临时 `<a>` 触发浏览器下载。
 *
 * - filename:浏览器下载文件名(若服务端未给或调用方需自定义时使用)。
 * - 非 OK 响应:尝试读 JSON body 的 error 字段,否则抛通用错误。
 *
 * 仅在浏览器环境可用(SSR 无 window 时直接抛错,调用方不应在 SSR 调用)。
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error('downloadFile 仅在浏览器环境可用');
  }
  const mockUserId = await bootstrapMockUser();
  const headers = new Headers({ Accept: 'application/octet-stream' });
  if (mockUserId) {
    headers.set('x-mock-user-id', mockUserId);
  }

  const res = await fetch(path, { headers });
  if (!res.ok) {
    // 同 apiFetch:SSO 模式 401 → 跳登录页。
    if (res.status === 401 && !mockUserId) {
      const returnTo = window.location.pathname + window.location.search;
      window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    }
    // 服务端错误仍以 JSON 返回(如 { error: '...' }),尽量解析出可读信息。
    let message = `请求失败 (${res.status})`;
    try {
      const ct = res.headers.get('Content-Type') ?? '';
      if (ct.includes('application/json')) {
        const body = (await res.json()) as { error?: unknown };
        if (body && typeof body.error === 'string') message = body.error;
      }
    } catch {
      // ignore parse error
    }
    throw new Error(message);
  }

  const blob = await res.blob();
  // 优先用响应头 Content-Disposition 里的文件名,回退到调用方传入的 filename。
  const finalName =
    parseFilenameFromDisposition(res.headers.get('Content-Disposition')) ?? filename;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 给浏览器一点时间发起下载再回收 object URL。
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 解析 Content-Disposition: attachment; filename="xxx.xlsx" 中的文件名。 */
function parseFilenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename="?([^";]+)"?/i.exec(header);
  return m ? m[1].trim() : null;
}

/**
 * 统一 fetch 封装:相对路径 + 注入 `x-mock-user-id` header + JSON 解析 + 错误规范化。
 * 非 OK 响应抛出 `{ status, message, body }`,调用方可 `try/catch` 取 `e.message`。
 *
 * 调用前会 `await bootstrapMockUser()` 确保身份就绪,从而消除数据页与
 * 顶部选择器 bootstrap 之间的竞态。一旦就绪,header 永远会被注入。
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  const mockUserId = await bootstrapMockUser();
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
    // SSO 模式(无 mock 身份)下 401 = 会话缺失/过期 → 跳登录页,回跳当前地址。
    // mock 模式不跳转:401 多为 localStorage 残留失效身份,交给调用方错误提示。
    if (res.status === 401 && !mockUserId && typeof window !== 'undefined') {
      const returnTo = window.location.pathname + window.location.search;
      window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    }
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
