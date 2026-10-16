import { Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';
import { validateAttachment } from '@/lib/attachments/config';
import { env } from '@/lib/env';

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

const metaSelect = {
  id: true,
  recordId: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.RecordAttachmentSelect;

/** 行 → AttachmentMeta(剔除 data)。 */
function toMeta(row: AttachmentMeta): AttachmentMeta {
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
    select: metaSelect,
  });
  return rows.map(toMeta);
}

/**
 * 取单个附件的二进制(下载用)。
 * 权限:project:view(基于附件实际归属的 projectId)。
 * 防护:recordId 必须与附件实际归属的记录一致(否则 404),
 * 防止用户用合法 recordId 的 URL 访问另一记录/项目的附件(IDOR)。
 * 返回 { meta, data },meta 含文件名/类型供路由拼 Content-Disposition。
 */
export async function getAttachmentData(
  id: string,
  recordId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<{ meta: AttachmentMeta; data: Buffer }> {
  const row = await prisma.recordAttachment.findUnique({
    where: { id },
    include: {
      record: { select: { projectId: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
  });

  // 用 404(非 403)统一"不存在/不属于本记录",避免泄露附件是否存在。
  if (!row || row.recordId !== recordId) throw new HTTPError(404, '附件不存在');
  await requirePermission(user, 'project:view', row.record.projectId);
  const { record, ...rest } = row;
  void record;
  return { meta: toMeta(rest), data: row.data };
}

/**
 * 新增附件(bytea 入库 + 审计)。
 * 权限:record:edit。
 * 校验:大小 ≤ env.MAX_ATTACHMENT_BYTES(默认 50MB,可由运维调整);类型白名单(扩展名+MIME 双校验)。
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
    env.MAX_ATTACHMENT_BYTES,
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
      select: metaSelect,
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
 * 权限:record:edit(基于附件实际归属的 projectId)。
 * 防护:recordId 必须与附件实际归属的记录一致(否则 404),
 * 防止跨记录/项目删除(IDOR)。
 */
export async function deleteAttachment(
  id: string,
  recordId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
  const row = await prisma.recordAttachment.findUnique({
    where: { id },
    select: { id: true, recordId: true, fileName: true, record: { select: { projectId: true } } },
  });
  // 用 404(非 403)统一"不存在/不属于本记录",避免泄露附件是否存在。
  if (!row || row.recordId !== recordId) throw new HTTPError(404, '附件不存在');
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
 * 批量导出筛选条件 → Prisma `where`(record 关联按 projectId + 可选年度/科目)。
 * 抽出来供 listForExport(查数据)与 countForExport(仅 count,不载 bytea)共享,
 * 保证"计数门槛"与"实际加载"用的是完全相同的过滤口径。
 */
function buildExportWhere(
  projectId: string,
  filters: { budgetYear?: number; subjectId?: string },
): Prisma.RecordAttachmentWhereInput {
  return {
    record: {
      projectId,
      ...(filters.budgetYear ? { budgetYear: filters.budgetYear } : {}),
      ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
    },
  };
}

/**
 * 计数:按项目(+可选年度/科目)统计附件数,**不加载 bytea data**。
 * 权限:project:view(与 listForExport 同口径,确保 count 见到的范围与加载一致)。
 * 路由层在调用 listForExport 前先用此廉价 count() 做硬上限校验,
 * 防止 listForExport 的 findMany 把全部 data 缓冲区读进堆导致 OOM。
 */
export async function countForExport(
  projectId: string,
  filters: { budgetYear?: number; subjectId?: string },
  user: Pick<User, 'id' | 'role'>,
): Promise<number> {
  await requirePermission(user, 'project:view', projectId);
  return prisma.recordAttachment.count({ where: buildExportWhere(projectId, filters) });
}

/**
 * 捕获附件成员与字节总量，不加载二进制，最多读取数量上限+1条元数据。
 * count 超过上限时只作哨兵；通过双门后必须把 ids 传给 listForExport。
 * 附件上传后不修改内容/大小，固定成员可避免排队期间新增突破容量预检。
 */
export async function selectForExport(
  projectId: string,
  filters: { budgetYear?: number; subjectId?: string },
  user: Pick<User, 'id' | 'role'>,
  maxAttachments: number,
): Promise<{ ids: string[]; count: number; totalBytes: number }> {
  await requirePermission(user, 'project:view', projectId);
  const rows = await prisma.recordAttachment.findMany({
    where: buildExportWhere(projectId, filters),
    select: { id: true, sizeBytes: true },
    orderBy: [{ record: { businessDate: 'asc' } }, { createdAt: 'asc' }, { id: 'asc' }],
    take: maxAttachments + 1,
  });
  return {
    ids: rows.map((row) => row.id),
    count: rows.length,
    totalBytes: rows.reduce((total, row) => total + row.sizeBytes, 0),
  };
}

/**
 * 批量导出:按项目(+可选年度/科目)取全部附件 + 关联业务上下文。
 * 权限:project:view。
 * 用于 zip 打包(路由层)。返回每项含 data 二进制。
 * HTTP打包传入通过数量/字节门的固定 attachmentIds，读取时重新校验项目权限。
 */
export async function listForExport(
  projectId: string,
  filters: { budgetYear?: number; subjectId?: string },
  user: Pick<User, 'id' | 'role'>,
  attachmentIds?: string[],
): Promise<
  Array<{
    record: {
      id: string;
      businessDate: Date;
      summary: string;
      handler: string;
      subjectId: string;
      amount: Prisma.Decimal;
      budgetYear: number;
      status: string;
    };
    attachment: AttachmentMeta;
    data: Buffer;
  }>
> {
  await requirePermission(user, 'project:view', projectId);
  const rows = await prisma.recordAttachment.findMany({
    where: {
      ...buildExportWhere(projectId, filters),
      ...(attachmentIds ? { id: { in: attachmentIds } } : {}),
    },
    include: {
      record: {
        select: {
          id: true,
          businessDate: true,
          summary: true,
          handler: true,
          subjectId: true,
          amount: true,
          budgetYear: true,
          status: true,
        },
      },
      uploadedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ record: { businessDate: 'asc' } }, { createdAt: 'asc' }],
  });
  if (attachmentIds && rows.length !== attachmentIds.length) {
    throw new HTTPError(409, '打包期间附件或记录已变更，请重试');
  }
  return rows.map((r) => {
    const { record, data, uploadedBy, ...meta } = r;
    void uploadedBy;
    return {
      record,
      attachment: toMeta({ ...meta, uploadedBy: r.uploadedBy }),
      data,
    };
  });
}
