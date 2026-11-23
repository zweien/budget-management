import { apiFetch, bootstrapMockUser } from '@/lib/api/client';
import type { SystemSettingsSnapshot } from '@/lib/system-settings';

/** 系统设置页的读写封装(读接口匿名;写接口仅 ADMIN 登录会话,权限在服务层把关)。 */

/** 读取当前生效的系统设置(接口不缓存,刷新即见管理员的最新保存)。失败抛 Error。 */
export async function fetchSystemSettings(): Promise<SystemSettingsSnapshot> {
  const body = await apiFetch<{ settings: SystemSettingsSnapshot }>('/api/settings');
  return body.settings;
}

/** 保存不含标志的卡片(JSON):只提交本次要改的键。 */
export async function saveSystemSettingsJson(
  patch: Record<string, unknown>,
): Promise<SystemSettingsSnapshot> {
  const body = await apiFetch<{ settings: SystemSettingsSnapshot }>('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return body.settings;
}

/** 保存品牌卡片(multipart:文本字段 + 标志文件),标量与标志同事务生效。 */
export async function saveSystemSettingsForm(form: FormData): Promise<SystemSettingsSnapshot> {
  // multipart 的 Content-Type 须由浏览器带 boundary 生成,故不走会补 JSON 头的 apiFetch
  // (与附件上传、迁移包导入同款)。
  const mockUserId = await bootstrapMockUser();
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: mockUserId ? { 'x-mock-user-id': mockUserId } : {},
    body: form,
  });
  const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json');
  const body: unknown = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    throw new Error(
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `保存失败 (${res.status})`,
    );
  }
  const settings = (body as { settings?: SystemSettingsSnapshot } | null)?.settings;
  if (!settings) throw new Error('保存失败:响应缺少 settings');
  return settings;
}
