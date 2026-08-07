import { Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';
import { MAX_ATTACHMENT_BYTES_DEFAULT, validateAttachment } from '@/lib/attachments/config';

/**
 * 业务记录报销凭证附件(RecordAttachment)。
 * 文件以 bytea 入库;附件是业务记录的渐进增强,不参与预算校验。
 *
 * 权限:上传/删除 = record:edit(ADMIN 或项目 OWNER/HANDLER);
 *       列表/下载/导出 = project:view(含 USER 全局只读)。
 * 不新增 Action,复用现有权限模型。
 */

/** 附件元数据(不含二进制 data,列表/返回前端用)。 */
export type AttachmentMeta = {
  id: string;
  recordId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: { id: string; name: string };
  createdAt: Date;
};

/** 上传入参(路由层从 File 转换而来)。 */
export interface AttachmentInput {
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
}

type AttachmentWithUploader = Prisma.RecordAttachmentGetPayload<{
  include: { uploadedBy: { select: { id: true; name: true } } };
}>;

/** 行 → AttachmentMeta(剔除 data)。 */
function toMeta(row: AttachmentWithUploader): AttachmentMeta {
  return {
    id: row.id,
    recordId: row.recordId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

/** 取记录(含 projectId,用于权限校验);不存在 → 404。 */
async function getRecordOrThrow(recordId: string) {
  const record = await prisma.businessRecord.findUnique({
    where: { id: recordId },
    select: { id: true, projectId: true, isVoid: true },
  });
  if (!record) throw new HTTPError(404, '业务记录不存在');
  return record;
}

/**
 * 列出某记录的全部附件元数据(不含二进制)。
 * 权限:project:view(含全局只读 USER)。
 */
export async function listAttachments(
  recordId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<AttachmentMeta[]> {
  const record = await getRecordOrThrow(recordId);
  await requirePermission(user, 'project:view', record.projectId);
  const rows = await prisma.recordAttachment.findMany({
    where: { recordId },
    orderBy: { createdAt: 'asc' },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  return rows.map(toMeta);
}

/**
 * 取单个附件的二进制(下载用)。
 * 权限:project:view。
 * 返回 { meta, data },meta 含文件名/类型供路由拼 Content-Disposition。
 */
export async function getAttachmentData(
  id: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<{ meta: AttachmentMeta; data: Buffer }> {
  const row = await prisma.recordAttachment.findUnique({
    where: { id },
    include: {
      record: { select: { projectId: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
  });

  if (!row) throw new HTTPError(404, '附件不存在');
  await requirePermission(user, 'project:view', row.record.projectId);
  const { record, ...rest } = row;
  void record;
  return { meta: toMeta(rest as AttachmentWithUploader), data: row.data };
}

/**
 * 新增附件(bytea 入库 + 审计)。
 * 权限:record:edit。
 * 校验:大小 ≤ MAX_ATTACHMENT_BYTES_DEFAULT;类型白名单(扩展名+MIME 双校验)。
 * 业务规则:作废记录(isVoid=true)不可追加附件 → 400。
 */
export async function createAttachment(
  recordId: string,
  file: AttachmentInput,
  user: Pick<User, 'id' | 'role'>,
): Promise<AttachmentMeta> {
  const record = await getRecordOrThrow(recordId);
  await requirePermission(user, 'record:edit', record.projectId);
  if (record.isVoid) {
    throw new HTTPError(400, '已作废的业务记录不可添加附件');
  }

  const verdict = validateAttachment(
    { name: file.name, type: file.type, size: file.size },
    MAX_ATTACHMENT_BYTES_DEFAULT,
  );
  if (!verdict.ok) throw new HTTPError(verdict.status, verdict.message);

  const id = uuidv7();
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.recordAttachment.create({
      data: {
        id,
        recordId,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        data: file.buffer,
        uploadedById: user.id,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    await recordAudit(tx, {
      projectId: record.projectId,
      objectType: 'record_attachments',
      objectId: id,
      action: 'record_attachment_upload',
      operatorId: user.id,
      after: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
    });
    return row;
  });
  return toMeta(created);
}

/**
 * 物理删除附件 + 审计。
 * 权限:record:edit。
 */
export async function deleteAttachment(id: string, user: Pick<User, 'id' | 'role'>): Promise<void> {
  const row = await prisma.recordAttachment.findUnique({
    where: { id },
    select: { id: true, recordId: true, fileName: true, record: { select: { projectId: true } } },
  });
  if (!row) throw new HTTPError(404, '附件不存在');
  await requirePermission(user, 'record:edit', row.record.projectId);

  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, {
      projectId: row.record.projectId,
      objectType: 'record_attachments',
      objectId: id,
      action: 'record_attachment_delete',
      operatorId: user.id,
      before: { fileName: row.fileName },
    });
    await tx.recordAttachment.delete({ where: { id } });
  });
}

/**
 * 批量导出:按项目(+可选年度/科目)取全部附件 + 关联业务上下文。
 * 权限:project:view。
 * 用于 zip 打包(路由层)。返回每项含 data 二进制。
 */
export async function listForExport(
  projectId: string,
  filters: { budgetYear?: number; subjectId?: string },
  user: Pick<User, 'id' | 'role'>,
): Promise<
  Array<{
    record: { id: string; businessDate: Date; summary: string; handler: string };
    attachment: AttachmentMeta;
    data: Buffer;
  }>
> {
  await requirePermission(user, 'project:view', projectId);
  const rows = await prisma.recordAttachment.findMany({
    where: {
      record: {
        projectId,
        ...(filters.budgetYear ? { budgetYear: filters.budgetYear } : {}),
        ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
      },
    },
    include: {
      record: { select: { id: true, businessDate: true, summary: true, handler: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ record: { businessDate: 'asc' } }, { createdAt: 'asc' }],
  });
  return rows.map((r) => {
    const { record, data, uploadedBy, ...meta } = r;
    void uploadedBy;
    return {
      record,
      attachment: toMeta({ ...meta, uploadedBy: r.uploadedBy } as AttachmentWithUploader),
      data,
    };
  });
}
