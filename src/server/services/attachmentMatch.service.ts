import { User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { matchDocNo } from '@/lib/attachments/docNoMatch';

/**
 * 批量附件导入的匹配预览(CONTEXT.md「批量附件导入」)。
 * 只接收文件名(+可选内容哈希),不接收文件字节;上传仍走既有单文件接口。
 *
 * 匹配:单据编号前缀 + 非字母数字边界 + 最长优先(docNoMatch);
 * 范围:项目内入口限定单项目(命中必唯一);统一入口跨项目——候选仅限
 * 用户有 record:edit 的非归档项目,唯一命中自动归属,同号跨项目标歧义。
 */

/** 单批文件数上限(逐文件串行上传,超限提示分批)。 */
export const MAX_BATCH_ATTACHMENT_FILES = 100;

export interface AttachmentMatchFileInput {
  name: string;
  /** 客户端 WebCrypto 预算的 SHA-256 hex;提供时预览即标注内容重复。 */
  contentHash?: string;
}

export interface AttachmentMatchCandidate {
  recordId: string;
  projectId: string;
  projectName: string;
  docNo: string;
  summary: string;
  amount: string;
  businessDate: string;
  attachmentCount: number;
  /** 该记录下已有同内容附件(附件内容去重命中)。 */
  duplicate: boolean;
  duplicateOfFileName?: string;
}

export type AttachmentMatchFileResult =
  | {
      name: string;
      status: 'matched';
      record: AttachmentMatchCandidate;
      duplicate: boolean;
      duplicateOfFileName?: string;
    }
  | { name: string; status: 'ambiguous'; candidates: AttachmentMatchCandidate[] }
  | { name: string; status: 'unmatched'; reason: 'no-record' | 'void-only' | 'no-permission' };

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

/** 校验并归一预览请求体;非法 → 400。 */
export function parseMatchPreviewFiles(body: unknown): AttachmentMatchFileInput[] {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new HTTPError(400, '请求体无效:需要非空 files 数组');
  }
  if (files.length > MAX_BATCH_ATTACHMENT_FILES) {
    throw new HTTPError(400, `单批最多 ${MAX_BATCH_ATTACHMENT_FILES} 个文件,请分批上传`);
  }
  return files.map((raw) => {
    const item = raw as { name?: unknown; contentHash?: unknown } | null;
    if (typeof item?.name !== 'string' || !item.name.trim() || item.name.length > 512) {
      throw new HTTPError(400, '文件名非法(非空、≤512 字符)');
    }
    const { name, contentHash } = item;
    if (
      contentHash !== undefined &&
      (typeof contentHash !== 'string' || !CONTENT_HASH_RE.test(contentHash))
    ) {
      throw new HTTPError(400, 'contentHash 非法(需 SHA-256 hex)');
    }
    return { name, ...(contentHash ? { contentHash } : {}) };
  });
}

/**
 * 匹配预览主入口。
 * @param projectId 项目内入口传项目上下文(要求 record:edit);统一入口不传(跨项目)。
 */
export async function matchAttachmentsPreview(
  files: AttachmentMatchFileInput[],
  user: Pick<User, 'id' | 'role'>,
  projectId?: string,
): Promise<{ files: AttachmentMatchFileResult[] }> {
  /** 可编辑项目集合(null = 管理员,全部非归档项目)。 */
  let editableProjects: Set<string> | null;
  if (projectId) {
    // 项目内入口:整个预览要求 record:edit(非成员 403、归档 409)。
    await requirePermission(user, 'record:edit', projectId);
    editableProjects = new Set([projectId]);
  } else if (user.role === 'ADMIN') {
    editableProjects = null;
  } else {
    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });
    editableProjects = new Set(memberships.map((m) => m.projectId));
  }
  // 归档项目不可 record:edit(上传会 409),预览阶段即排除。
  const archived = await prisma.project.findMany({
    where: { archivedAt: { not: null } },
    select: { id: true },
  });
  const archivedIds = new Set(archived.map((p) => p.id));
  const isEditable = (pid: string) =>
    !archivedIds.has(pid) && (editableProjects === null || editableProjects.has(pid));

  // 候选宇宙:带 docNo 的记录(含已作废,用于区分 void-only;项目内入口限定单项目)。
  const rows = await prisma.businessRecord.findMany({
    where: { docNo: { not: null }, ...(projectId ? { projectId } : {}) },
    select: { id: true, projectId: true, docNo: true, isVoid: true },
  });
  const docNos = [...new Set(rows.map((r) => r.docNo).filter((d): d is string => !!d))];
  const byDocNo = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.docNo) continue;
    const list = byDocNo.get(row.docNo) ?? [];
    list.push(row);
    byDocNo.set(row.docNo, list);
  }

  // 命中记录的详情与既有附件(计数/内容去重标记),一次性批量取。
  const detailIds = new Set<string>();
  type PrelimRow =
    | { file: AttachmentMatchFileInput; status: 'matched' | 'ambiguous'; records: typeof rows }
    | {
        file: AttachmentMatchFileInput;
        status: 'unmatched';
        reason: 'no-record' | 'void-only' | 'no-permission';
      };
  const prelim: PrelimRow[] = files.map((file): PrelimRow => {
    const hit = matchDocNo(file.name, docNos);
    if (!hit) return { file, status: 'unmatched', reason: 'no-record' };
    const candidates = byDocNo.get(hit)!;
    const editable = candidates.filter((c) => !c.isVoid && isEditable(c.projectId));
    if (editable.length >= 1) {
      editable.forEach((c) => detailIds.add(c.id));
      // 项目内同号唯一(部分唯一索引),多条即跨项目 → 歧义待人工指定。
      return editable.length === 1
        ? { file, status: 'matched', records: editable }
        : { file, status: 'ambiguous', records: editable };
    }
    return candidates.some((c) => !c.isVoid)
      ? { file, status: 'unmatched', reason: 'no-permission' }
      : { file, status: 'unmatched', reason: 'void-only' };
  });

  const detailRows = detailIds.size
    ? await prisma.businessRecord.findMany({
        where: { id: { in: [...detailIds] } },
        select: {
          id: true,
          projectId: true,
          docNo: true,
          summary: true,
          amount: true,
          businessDate: true,
          project: { select: { name: true } },
        },
      })
    : [];
  const attRows = detailIds.size
    ? await prisma.recordAttachment.findMany({
        where: { recordId: { in: [...detailIds] } },
        select: { recordId: true, fileName: true, contentHash: true },
      })
    : [];
  const detailById = new Map(detailRows.map((r) => [r.id, r]));
  const attsByRecord = new Map<string, typeof attRows>();
  for (const att of attRows) {
    const list = attsByRecord.get(att.recordId) ?? [];
    list.push(att);
    attsByRecord.set(att.recordId, list);
  }

  const toCandidate = (
    recordId: string,
    file: AttachmentMatchFileInput,
  ): AttachmentMatchCandidate => {
    const detail = detailById.get(recordId)!;
    const atts = attsByRecord.get(recordId) ?? [];
    const dup = file.contentHash ? atts.find((a) => a.contentHash === file.contentHash) : undefined;
    return {
      recordId,
      projectId: detail.projectId,
      projectName: detail.project.name,
      docNo: detail.docNo ?? '',
      summary: detail.summary,
      amount: detail.amount.toString(),
      businessDate: detail.businessDate.toISOString(),
      attachmentCount: atts.length,
      duplicate: !!dup,
      ...(dup ? { duplicateOfFileName: dup.fileName } : {}),
    };
  };

  return {
    files: prelim.map((item) => {
      if (item.status === 'unmatched') {
        return { name: item.file.name, status: 'unmatched', reason: item.reason };
      }
      if (item.status === 'matched') {
        const record = toCandidate(item.records[0].id, item.file);
        return {
          name: item.file.name,
          status: 'matched',
          record,
          duplicate: record.duplicate,
          ...(record.duplicateOfFileName
            ? { duplicateOfFileName: record.duplicateOfFileName }
            : {}),
        };
      }
      return {
        name: item.file.name,
        status: 'ambiguous',
        candidates: item.records.map((r) => toCandidate(r.id, item.file)),
      };
    }),
  };
}
