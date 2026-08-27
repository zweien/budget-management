/**
 * 报销凭证附件的客户端 API 封装。
 *
 * 上传走 multipart,必须绕过 apiFetch(它强制 Content-Type: application/json),
 * 改用裸 fetch + bootstrapMockUser() 注入 x-mock-user-id,对齐 imports/page.tsx。
 * 下载/导出复用 downloadFile(blob 流式 + Content-Disposition 文件名)。
 */

import { apiFetch, bootstrapMockUser, downloadFile } from '@/lib/api/client';

export interface AttachmentMeta {
  id: string;
  recordId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: { id: string; name: string };
  createdAt: string;
}

/** 列出某业务记录的全部附件元数据。 */
export async function listAttachments(
  projectId: string,
  recordId: string,
): Promise<AttachmentMeta[]> {
  const data = await apiFetch<{ attachments: AttachmentMeta[] }>(
    `/api/projects/${projectId}/records/${recordId}/attachments`,
  );
  return data.attachments;
}

/** 上传单个附件(multipart)。失败抛 Error(message 为服务端 error 文案)。 */
export async function uploadAttachment(
  projectId: string,
  recordId: string,
  file: File,
): Promise<AttachmentMeta> {
  const mockUserId = await bootstrapMockUser();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/projects/${projectId}/records/${recordId}/attachments`, {
    method: 'POST',
    headers: mockUserId ? { 'x-mock-user-id': mockUserId } : {},
    body: form,
  });
  const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `上传失败 (${res.status})`;
    throw new Error(msg);
  }
  return body as AttachmentMeta;
}

/** 删除单个附件。 */
export async function deleteAttachment(
  projectId: string,
  recordId: string,
  attId: string,
): Promise<void> {
  await apiFetch(`/api/projects/${projectId}/records/${recordId}/attachments/${attId}`, {
    method: 'DELETE',
  });
}

/** 下载单个附件(浏览器触发文件保存)。 */
export function downloadAttachment(
  projectId: string,
  recordId: string,
  attId: string,
): Promise<void> {
  return downloadFile(
    `/api/projects/${projectId}/records/${recordId}/attachments/${attId}`,
    'attachment',
  );
}

/** 批量导出附件 zip(沿用筛选:年度/科目)。 */
export function exportAttachmentsZip(
  projectId: string,
  query: { budgetYear?: number; subjectId?: string },
): Promise<void> {
  const sp = new URLSearchParams();
  if (query.budgetYear) sp.set('budgetYear', String(query.budgetYear));
  if (query.subjectId) sp.set('subjectId', query.subjectId);
  const qs = sp.toString();
  return downloadFile(
    `/api/projects/${projectId}/attachments/export${qs ? `?${qs}` : ''}`,
    'attachments.zip',
  );
}

/**
 * 按预算科目层级打包附件(整理报告专用)。
 * 文件夹按科目目录层级,文件名按 template 模板渲染。默认全年度;year 可选筛选。
 */
export function packageAttachmentsBySubject(
  projectId: string,
  query: { year?: number; template?: string },
): Promise<void> {
  const sp = new URLSearchParams();
  if (query.year) sp.set('year', String(query.year));
  if (query.template) sp.set('template', query.template);
  const qs = sp.toString();
  return downloadFile(
    `/api/projects/${projectId}/attachments/package${qs ? `?${qs}` : ''}`,
    'attachments.zip',
  );
}

/**
 * 拉取附件字节(供 file-viewer 在线预览,§issue18)。
 * 鉴权同 downloadAttachment:Mock 模式 bootstrapMockUser 注入 x-mock-user-id;
 * SSO 模式同源 fetch 自动带 bm_session cookie。
 * 返回 Blob,由调用方转 ArrayBuffer 喂渲染器(不经 object URL,无泄漏面)。
 */
export async function fetchAttachmentBlob(
  projectId: string,
  recordId: string,
  attId: string,
): Promise<Blob> {
  const mockUserId = await bootstrapMockUser();
  const res = await fetch(`/api/projects/${projectId}/records/${recordId}/attachments/${attId}`, {
    headers: {
      ...(mockUserId ? { 'x-mock-user-id': mockUserId } : {}),
      Accept: 'application/octet-stream',
    },
  });
  if (!res.ok) {
    // 解析服务端 {error} 文案(下载路由错误返回 JSON)。
    let msg = `加载失败 (${res.status})`;
    try {
      const ct = res.headers.get('Content-Type') ?? '';
      if (ct.includes('application/json')) {
        const body = (await res.json()) as { error?: unknown };
        if (body && typeof body.error === 'string') msg = body.error;
      }
    } catch {
      // ignore parse error
    }
    throw new Error(msg);
  }
  return res.blob();
}
