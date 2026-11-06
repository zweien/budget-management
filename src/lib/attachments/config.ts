/**
 * 附件校验配置(纯函数,无 IO/无 DB,便于单测)。
 * 大小上限/白名单的"运行期"值由 env 注入(见 Task 5);此处给默认值与校验逻辑。
 */

/** 默认单文件大小上限:50MB(防 OOM,非业务限制)。 */
export const MAX_ATTACHMENT_BYTES_DEFAULT = 50 * 1024 * 1024;

/**
 * 允许的文件类型规范:扩展名 + MIME 双白名单(两者都要命中才算合法,防伪造)。
 * previewable 标记该类型能否在线预览(单一事实源:预览白名单由此派生,
 * 消费方见 PREVIEWABLE_ATTACHMENT_EXTENSIONS)。
 */
export const ALLOWED_ATTACHMENT_SPEC = [
  { extensions: ['.jpg', '.jpeg'], mimeTypes: ['image/jpeg'], previewable: true },
  { extensions: ['.png'], mimeTypes: ['image/png'], previewable: true },
  { extensions: ['.webp'], mimeTypes: ['image/webp'], previewable: true },
  { extensions: ['.gif'], mimeTypes: ['image/gif'], previewable: true },
  { extensions: ['.pdf'], mimeTypes: ['application/pdf'], previewable: true },
  {
    extensions: ['.doc'],
    mimeTypes: ['application/msword'],
    previewable: true,
  },
  {
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    previewable: true,
  },
  {
    extensions: ['.xls'],
    mimeTypes: ['application/vnd.ms-excel'],
    previewable: true,
  },
  {
    extensions: ['.xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    previewable: true,
  },
  {
    // ppt/pptx 渲染资产未自托管(见 scripts/copy-file-viewer-assets.mjs 裁剪):
    // 可上传,但在线预览维持"不支持,请下载"兜底;恢复资产后改 true 即得预览。
    extensions: ['.ppt'],
    mimeTypes: ['application/vnd.ms-powerpoint'],
    previewable: false,
  },
  {
    extensions: ['.pptx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    previewable: false,
  },
] as const;

/**
 * 可在线预览的附件扩展名(小写含点),由 ALLOWED_ATTACHMENT_SPEC 的
 * previewable 标记派生。消费方按文件名后缀判定(与 file-viewer 的格式识别
 * 依据一致;上传时扩展名/MIME 已双白名单校验一致,图片/PDF 同样由扩展名覆盖)。
 */
export const PREVIEWABLE_ATTACHMENT_EXTENSIONS: readonly string[] = ALLOWED_ATTACHMENT_SPEC.filter(
  (s) => s.previewable,
).flatMap((s) => [...s.extensions]);

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
