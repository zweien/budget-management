/**
 * 附件校验配置(纯函数,无 IO/无 DB,便于单测)。
 * 大小上限/白名单的"运行期"值由 env 注入(见 Task 5);此处给默认值与校验逻辑。
 */

/** 默认单文件大小上限:50MB(防 OOM,非业务限制)。 */
export const MAX_ATTACHMENT_BYTES_DEFAULT = 50 * 1024 * 1024;

/** 允许的文件类型规范:扩展名 + MIME 双白名单(两者都要命中才算合法,防伪造)。 */
export const ALLOWED_ATTACHMENT_SPEC = [
  { extensions: ['.jpg', '.jpeg'], mimeTypes: ['image/jpeg'] },
  { extensions: ['.png'], mimeTypes: ['image/png'] },
  { extensions: ['.webp'], mimeTypes: ['image/webp'] },
  { extensions: ['.gif'], mimeTypes: ['image/gif'] },
  { extensions: ['.pdf'], mimeTypes: ['application/pdf'] },
  {
    extensions: ['.doc'],
    mimeTypes: ['application/msword'],
  },
  {
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  {
    extensions: ['.xls'],
    mimeTypes: ['application/vnd.ms-excel'],
  },
  {
    extensions: ['.xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  },
  {
    extensions: ['.ppt'],
    mimeTypes: ['application/vnd.ms-powerpoint'],
  },
  {
    extensions: ['.pptx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  },
] as const;

export interface AttachmentCandidate {
  name: string;
  type: string;
  size: number;
}

export type ValidationResult = { ok: true } | { ok: false; status: number; message: string };

/** 校验单个附件候选:大小 + 扩展名/MIME 双白名单。 */
export function validateAttachment(file: AttachmentCandidate, maxBytes: number): ValidationResult {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, status: 400, message: '文件为空' };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      status: 413,
      message: `文件过大(上限 ${humanFileSize(maxBytes)}):${file.name}`,
    };
  }
  const ext = /(\.[^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (!ext) {
    return { ok: false, status: 415, message: `无法识别文件类型(无扩展名):${file.name}` };
  }
  const hit = ALLOWED_ATTACHMENT_SPEC.find(
    (s) => s.extensions.includes(ext as never) || s.mimeTypes.includes(file.type as never),
  );
  if (!hit) {
    return { ok: false, status: 415, message: `不支持的文件类型:${file.name}` };
  }
  // 双白名单:扩展名和 MIME 都要落在同一组(防 .pdf 伪造成 image/jpeg 等)。
  if (!hit.extensions.includes(ext as never) || !hit.mimeTypes.includes(file.type as never)) {
    return { ok: false, status: 415, message: `文件类型与扩展名不一致:${file.name}` };
  }
  return { ok: true };
}

/** 体积人类可读:1024 进制,KB/MB 一位小数。 */
export function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
