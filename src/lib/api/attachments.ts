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
