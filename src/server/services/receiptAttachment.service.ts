import { Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';
import { validateAttachment } from '@/lib/attachments/config';
import { env } from '@/lib/env';

/**
 * 到账流水附件(ReceiptAttachment):与 RecordAttachment 同构(§渐进增强)。
 * 文件以 bytea 入库,不参与预算校验。
 *
 * 权限:上传/删除 = record:edit(ADMIN 或项目 OWNER/HANDLER,与到账登记/修改同款);
 *       列表/下载 = project:view(含 USER 全局只读)。
 * 不新增 Action,复用现有权限模型。
 */

/** 附件元数据(不含二进制 data)。 */
export type ReceiptAttachmentMeta = {
  id: string;
  receiptId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: { id: string; name: string };
  createdAt: Date;
};

/** 上传入参(路由层从 File 转换而来;与 record 附件同构)。 */
export interface ReceiptAttachmentInput {
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
}

const metaSelect = {
  id: true,
  receiptId: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.ReceiptAttachmentSelect;

type MetaRow = {
  id: string;
  receiptId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  uploadedBy: { id: string; name: string };
};

function toMeta(row: MetaRow): ReceiptAttachmentMeta {
  return {
    id: row.id,
    receiptId: row.receiptId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

/** 取到账记录(含 projectId,用于权限校验);不存在 → 404。 */
async function getReceiptOrThrow(receiptId: string) {
  const receipt = await prisma.receiptRecord.findUnique({
    where: { id: receiptId },
    select: { id: true, projectId: true },
  });
  if (!receipt) throw new HTTPError(404, '到账记录不存在');
  return receipt;
}

/**
 * 列出某到账记录的全部附件元数据(不含二进制)。
 * 权限:project:view。
 */
export async function listReceiptAttachments(
  receiptId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<ReceiptAttachmentMeta[]> {
  const receipt = await getReceiptOrThrow(receiptId);
  await requirePermission(user, 'project:view', receipt.projectId);
  const rows = await prisma.receiptAttachment.findMany({
    where: { receiptId },
    orderBy: { createdAt: 'asc' },
    select: metaSelect,
  });
  return rows.map(toMeta);
}

/**
 * 取单个附件的二进制(下载/预览用)。
 * 权限:project:view(基于附件实际归属的 projectId)。
 * 防护:receiptId 必须与附件实际归属一致(否则 404),防 IDOR。
 */
export async function getReceiptAttachmentData(
  id: string,
  receiptId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<{ meta: ReceiptAttachmentMeta; data: Buffer }> {
  const row = await prisma.receiptAttachment.findUnique({
    where: { id },
    include: {
      receipt: { select: { projectId: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
  });
  if (!row || row.receiptId !== receiptId) throw new HTTPError(404, '附件不存在');
  await requirePermission(user, 'project:view', row.receipt.projectId);
  const { receipt, ...rest } = row;
  void receipt;
  return { meta: toMeta(rest), data: row.data };
}

/**
 * 新增附件(bytea 入库 + 审计)。
 * 权限:record:edit;校验与 record 附件同款(大小 ≤ env.MAX_ATTACHMENT_BYTES,
 * 类型白名单扩展名+MIME 双校验)。
 */
export async function createReceiptAttachment(
  receiptId: string,
  file: ReceiptAttachmentInput,
  user: Pick<User, 'id' | 'role'>,
): Promise<ReceiptAttachmentMeta> {
  const receipt = await getReceiptOrThrow(receiptId);
  await requirePermission(user, 'record:edit', receipt.projectId);

  const verdict = validateAttachment(
    { name: file.name, type: file.type, size: file.size },
    env.MAX_ATTACHMENT_BYTES,
  );
  if (!verdict.ok) throw new HTTPError(verdict.status, verdict.message);

  const id = uuidv7();
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.receiptAttachment.create({
      data: {
        id,
        receiptId,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        data: file.buffer,
        uploadedById: user.id,
      },
      select: metaSelect,
    });
    await recordAudit(tx, {
      projectId: receipt.projectId,
      objectType: 'receipt_attachments',
      objectId: id,
      action: 'receipt_attachment_upload',
      operatorId: user.id,
      after: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
    });
    return row;
  });
  return toMeta(created);
}

/**
 * 物理删除附件 + 审计。
 * 权限:record:edit(基于附件实际归属的 projectId);receiptId 不符 → 404(IDOR)。
 */
export async function deleteReceiptAttachment(
  id: string,
  receiptId: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
  const row = await prisma.receiptAttachment.findUnique({
    where: { id },
    select: { id: true, receiptId: true, fileName: true, receipt: { select: { projectId: true } } },
  });
  if (!row || row.receiptId !== receiptId) throw new HTTPError(404, '附件不存在');
  await requirePermission(user, 'record:edit', row.receipt.projectId);

  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, {
      projectId: row.receipt.projectId,
      objectType: 'receipt_attachments',
      objectId: id,
      action: 'receipt_attachment_delete',
      operatorId: user.id,
      before: { fileName: row.fileName },
    });
    await tx.receiptAttachment.delete({ where: { id } });
  });
}
