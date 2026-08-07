# 业务记录报销凭证附件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每笔业务记录（`BusinessRecord`）可上传报销凭证附件，并支持事后查看/补充/删除、按项目批量打包导出，便于后期整理经费报告。

**Architecture:** 附件文件以二进制存入 PostgreSQL `bytea` 列（随库备份、零额外基础设施）。新增 `RecordAttachment` 模型 + 服务层 + 5 个 API 路由；前端在记录表格新增附件徽标列打开侧边抽屉（拖拽上传/列表/下载/删除），并在创建/编辑表单内附带可选附件（先 JSON 存业务、再循环上传附件，二者解耦）。批量导出复用现有筛选条件打包 zip。

**Tech Stack:** Next.js 16 (App Router, Node runtime) · React 19 · Prisma 5 · PostgreSQL · zod · react-hook-form · shadcn/ui · TanStack Table · jszip · vitest（集成测试，真实 PG `:5434`，串行）

## Global Constraints

- **测试是集成测试**，直连真实 PostgreSQL `budget@localhost:5434`，`vitest.config.ts` 配 `pool: 'forks'` + `singleFork: true`（串行）。每个测试自建项目/记录/附件并在 `afterAll` 级联清理。
- **权限不新增 action**：上传/删除复用 `requirePermission(user, 'record:edit', projectId)`；列表/下载/导出复用 `requirePermission(user, 'project:view', projectId)`。两者已在 `src/lib/auth/permissions.ts` 的 `RECORD_WRITE_ACTIONS` / 矩阵中。
- **API 路由签名**：Next.js 16 异步 params —— `{ params }: { params: Promise<{ id: string; recordId: string }> }`，体内 `const { ... } = await params`。
- **客户端 multipart 上传绕过 `apiFetch`**（它强制 `Content-Type: application/json`），用裸 `fetch` + `bootstrapMockUser()` 注入 `x-mock-user-id`，对齐 `imports/page.tsx` 的 `uploadExcel`。
- **下载**用 `downloadFile()`（`src/lib/api/client.ts`），blob 流式 + `Content-Disposition` 文件名解析。
- **审计**走 `recordAudit(tx, {...})`（`src/server/audit/interceptor.ts`），必须在 `prisma.$transaction` 内调用，`objectType` 用字符串（无需 enum）。
- **ID** 统一 `uuidv7()`（`src/lib/id.ts`），主键 `@db.Uuid`。
- **错误**抛 `HTTPError(status, message)`（`src/lib/auth/session.ts`），路由 catch 后转 `{ error }` JSON。
- **单文件硬上限 50MB**（`MAX_ATTACHMENT_BYTES`，防 OOM），类型白名单：图片(jpeg/png/webp/gif) + PDF + Office(doc/docx/xls/xlsx/ppt/pptx)。
- **正文 Body 大小**：Next 16 App Router Node 运行时对 multipart 字段有默认上限；本计划在 Task 3 步骤里**先实测** 50MB 是否被拒，据此决定是否需要路由内或 `next.config.ts` 调整。此为已识别风险，不阻塞前序任务。
- **版本发布**（最终，非本计划必做）：按 AGENTS.md 走 `npm version minor`（`feat`），但**禁止手改 `package.json` 的 `version`**。

## File Structure

**新增文件：**

| 文件                                                                        | 职责                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `prisma/migrations/<ts>_record_attachments/migration.sql`                   | prisma 生成；CREATE TABLE                                                                                            |
| `src/server/services/recordAttachment.service.ts`                           | 附件领域逻辑：list/get/create/delete/listForExport + 校验 + 权限 + 审计（唯一文件 IO 入口）                          |
| `src/lib/attachments/config.ts`                                             | 纯函数：大小上限、类型白名单、MIME↔扩展名校验（无副作用，便于单测）                                                  |
| `src/app/api/projects/[id]/records/[recordId]/attachments/route.ts`         | POST 上传(multipart) + GET 列表                                                                                      |
| `src/app/api/projects/[id]/records/[recordId]/attachments/[attId]/route.ts` | GET 下载 + DELETE 删除                                                                                               |
| `src/app/api/projects/[id]/attachments/export/route.ts`                     | GET 批量导出 zip                                                                                                     |
| `src/lib/api/attachments.ts`                                                | 客户端工具：`uploadAttachment` / `downloadAttachment` / `listAttachments` / `deleteAttachment` / `exportAttachments` |
| `src/components/records/AttachmentSheet.tsx`                                | 附件侧边抽屉（拖拽上传、列表、下载、删除、进度、大小提示）                                                           |
| `tests/server/recordAttachment.service.test.ts`                             | 服务层集成测试                                                                                                       |
| `tests/api/attachments.route.test.ts`                                       | 路由集成测试（上传→列表→下载→删除 + 导出）                                                                           |

**修改文件：**

| 文件                                                 | 改动                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `prisma/schema.prisma`                               | 新增 `RecordAttachment` 模型；`BusinessRecord` 加 `attachments` 反向关系；`User` 加 `uploadedAttachments` 反向关系 |
| `src/lib/env.ts`                                     | 加 `MAX_ATTACHMENT_BYTES`（默认 50MB）、`ALLOWED_ATTACHMENT_TYPES`（默认白名单）                                   |
| `.env.example`                                       | 补上述变量注释                                                                                                     |
| `src/app/(dashboard)/projects/[id]/records/page.tsx` | 表单内附件区块 + `submitForm` 改造（先存业务再传附件）+ 表格附件徽标列 + 工具栏导出按钮 + `AttachmentSheet` 集成   |

**职责边界**：`config.ts` 是纯校验（无 DB/无 IO），`service.ts` 是领域逻辑（DB + 审计），路由只做 multipart 解析 + 错误转译，客户端 `attachments.ts` 只做 fetch 封装，`AttachmentSheet.tsx` 是纯 UI。文件之间通过明确签名耦合（见各 Task 的 Interfaces 块）。

---

## Task 1: Prisma 模型与迁移

**Files:**

- Modify: `prisma/schema.prisma`（`BusinessRecord` 模型约 line 297-327；`User` 模型 line 40-62）
- Create: `prisma/migrations/<ts>_record_attachments/migration.sql`（prisma 自动生成）

**Interfaces:**

- Consumes: 无（地基任务）
- Produces: `RecordAttachment` Prisma 模型 + `prisma.recordAttachment.*` client 方法；`BusinessRecord` 多出 `attachments` 关系；`User` 多出 `uploadedAttachments` 关系。后续所有 Task 依赖此模型。

- [ ] **Step 1: 修改 schema.prisma — 给 User 加反向关系**

在 `model User`（约 line 40-62）的 `receipts          ReceiptRecord[]` 这一行**下方**新增一行反向关系：

```
  receipts          ReceiptRecord[]
  uploadedAttachments RecordAttachment[] @relation("AttachmentUploader")
```

- [ ] **Step 2: 修改 schema.prisma — 给 BusinessRecord 加反向关系**

在 `model BusinessRecord`（约 line 297-327）的 `history    BusinessRecordHistory[]` 这一行**下方**新增一行反向关系：

```
  history    BusinessRecordHistory[]
  attachments RecordAttachment[]
```

- [ ] **Step 3: 修改 schema.prisma — 在文件末尾新增 RecordAttachment 模型**

在文件最末尾追加：

```prisma
model RecordAttachment {
  id            String   @id @db.Uuid
  recordId      String   @map("record_id") @db.Uuid
  fileName      String   @map("file_name")
  contentType   String   @map("content_type")
  sizeBytes     Int      @map("size_bytes")
  data          Bytes
  uploadedById  String   @map("uploaded_by") @db.Uuid
  createdAt     DateTime @default(now()) @map("created_at")

  record       BusinessRecord @relation(fields: [recordId], references: [id], onDelete: Cascade)
  uploadedBy   User           @relation("AttachmentUploader", fields: [uploadedById], references: [id])

  @@index([recordId])
  @@map("record_attachments")
}
```

- [ ] **Step 4: 生成迁移**

Run: `npx prisma migrate dev --name record_attachments`
Expected: 创建 `prisma/migrations/<ts>_record_attachments/migration.sql`，内容是 `CREATE TABLE "record_attachments" (...)` + 索引 + 外键（含 `ON DELETE CASCADE`）。client 自动重新生成。

- [ ] **Step 5: 验证模型可用**

Run: `npx prisma studio --port 5556 &`，浏览器打开后能看到 `RecordAttachment` 表（字段：id/record_id/file_name/content_type/size_bytes/data/uploaded_by/created_at）。验证后 `kill %1` 停掉。
Expected: 表存在，字段齐全；`npx prisma validate` 输出 `The schema at prisma/schema.prisma is valid 🚀`。

- [ ] **Step 6: 类型检查确认无回归**

Run: `npm run check-types`
Expected: PASS（现有 `BusinessRecord` 类型会自动获得可选 `attachments` 字段，但不影响未显式 `include` 的消费代码）。

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): 新增 record_attachments 表(业务记录报销凭证附件)"
```

---

## Task 2: 附件校验配置（纯函数）

**Files:**

- Create: `src/lib/attachments/config.ts`
- Test: `tests/lib/attachments/config.test.ts`

**Interfaces:**

- Consumes: `src/lib/env.ts` 的 `env`（但为可测试，config.ts 不直接读 env，而是把上限作为参数；路由/服务层从 env 注入——见 Task 5）
- Produces:
  - `MAX_ATTACHMENT_BYTES_DEFAULT = 50 * 1024 * 1024`
  - `ALLOWED_ATTACHMENT_SPEC: Array<{ extensions: string[]; mimeTypes: string[] }>`
  - `validateAttachment({ name, type, size }, maxBytes): { ok: true } | { ok: false; status: number; message: string }`
  - `humanFileSize(bytes): string`

- [ ] **Step 1: 写失败测试 — 类型与大小校验**

创建 `tests/lib/attachments/config.test.ts`：

```ts
import { describe, it, expect } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES_DEFAULT,
  validateAttachment,
  humanFileSize,
} from '@/lib/attachments/config';

const MAX = MAX_ATTACHMENT_BYTES_DEFAULT; // 50MB

describe('validateAttachment', () => {
  it('合法 PDF 通过', () => {
    const r = validateAttachment({ name: '发票.pdf', type: 'application/pdf', size: 1024 }, MAX);
    expect(r.ok).toBe(true);
  });

  it('合法图片通过(jpeg)', () => {
    const r = validateAttachment({ name: 'a.jpg', type: 'image/jpeg', size: 100 }, MAX);
    expect(r.ok).toBe(true);
  });

  it('合法 docx 通过', () => {
    const r = validateAttachment(
      {
        name: '明细.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 100,
      },
      MAX,
    );
    expect(r.ok).toBe(true);
  });

  it('超 50MB → ok:false status:413', () => {
    const r = validateAttachment({ name: 'big.pdf', type: 'application/pdf', size: MAX + 1 }, MAX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it('非白名单 MIME → ok:false status:415', () => {
    const r = validateAttachment(
      { name: 'a.exe', type: 'application/x-msdownload', size: 10 },
      MAX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it('MIME 白名单但扩展名不符 → ok:false status:415(防伪造)', () => {
    const r = validateAttachment(
      { name: 'evil.pdf', type: 'application/x-msdownload', size: 10 },
      MAX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it('扩展名白名单但 MIME 不符 → ok:false status:415', () => {
    const r = validateAttachment({ name: 'a.pdf', type: 'image/jpeg', size: 10 }, MAX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it('无扩展名 → ok:false status:415', () => {
    const r = validateAttachment({ name: 'noext', type: 'application/pdf', size: 10 }, MAX);
    expect(r.ok).toBe(false);
  });
});

describe('humanFileSize', () => {
  it('字节级显示 B', () => expect(humanFileSize(500)).toBe('500 B'));
  it('KB 一位小数', () => expect(humanFileSize(1024)).toBe('1.0 KB'));
  it('MB 一位小数', () => expect(humanFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/lib/attachments/config.test.ts`
Expected: FAIL（模块不存在，`Cannot find module '@/lib/attachments/config'`）。

- [ ] **Step 3: 实现 config.ts**

创建 `src/lib/attachments/config.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/lib/attachments/config.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/attachments/config.ts tests/lib/attachments/config.test.ts
git commit -m "feat(attachments): 附件大小/类型校验纯函数"
```

---

## Task 3: 附件服务层

**Files:**

- Create: `src/server/services/recordAttachment.service.ts`
- Test: `tests/server/recordAttachment.service.test.ts`

**Interfaces:**

- Consumes:
  - `prisma`（`@/lib/prisma`）、`requirePermission`（`@/lib/auth/permissions`）、`recordAudit`（`@/server/audit/interceptor`）、`uuidv7`（`@/lib/id`）、`HTTPError`（`@/lib/auth/session`）
  - `validateAttachment` + `MAX_ATTACHMENT_BYTES_DEFAULT`（`@/lib/attachments/config`，Task 2）
  - `RecordAttachment`、`User` 类型（`@prisma/client`，Task 1）
- Produces:
  - `type AttachmentMeta = { id, recordId, fileName, contentType, sizeBytes, uploadedBy: { id, name }, createdAt }`（**不含 `data`**）
  - `type AttachmentInput = { name: string; type: string; size: number; buffer: Buffer }`
  - `listAttachments(recordId: string, user): Promise<AttachmentMeta[]>`
  - `getAttachmentData(id: string, user): Promise<{ meta: AttachmentMeta; data: Buffer }>`（下载用，含二进制）
  - `createAttachment(recordId: string, file: AttachmentInput, user): Promise<AttachmentMeta>`
  - `deleteAttachment(id: string, user): Promise<void>`
  - `listForExport(projectId: string, filters: { budgetYear?: number; subjectId?: string }, user): Promise<Array<{ record: { id, businessDate: Date, summary, handler }, attachment: AttachmentMeta, data: Buffer }>>`

- [ ] **Step 1: 写失败测试 — 服务层集成测试**

创建 `tests/server/recordAttachment.service.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { createRecord } from '@/server/services/businessRecord.service';
import {
  listAttachments,
  getAttachmentData,
  createAttachment,
  deleteAttachment,
  listForExport,
} from '@/server/services/recordAttachment.service';
import { MAX_ATTACHMENT_BYTES_DEFAULT } from '@/lib/attachments/config';

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.recordAttachment.deleteMany({ where: { record: { projectId } } }).catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('recordAttachment.service (integration, real PG)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  let adminId: string;
  let outsiderId: string;
  const adminUser = () => ({ id: adminId, role: UserRole.ADMIN });
  const outsiderUser = () => ({ id: outsiderId, role: UserRole.USER });

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'admin-att', role: UserRole.ADMIN },
        { id: outsiderId, name: 'outsider-att', role: UserRole.USER },
      ],
    });
    createdUserIds.push(adminId, outsiderId);
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function seedRecord(suffix: string) {
    const code = `ATT-${suffix}-${uuidv7().slice(0, 8)}`;
    const project = await createProject({ code, name: `att ${suffix}` }, adminUser());
    createdProjectIds.push(project.id);
    // 需要先有科目。createRecord 内部 requirePermission + 校验科目存在。
    // 取项目的第一个叶科目:建项目时 createProject 已建初始科目树。
    const subject = await prisma.budgetSubject.findFirst({
      where: { projectId: project.id, isLeaf: true },
    });
    if (!subject) throw new Error('测试夹具:项目无叶科目');
    const { record } = await createRecord(
      project.id,
      {
        budgetYear: 2026,
        subjectId: subject.id,
        amount: '100.00',
        businessDate: '2026-08-05',
        handler: '张三',
        summary: `附件测试-${suffix}`,
        status: 'PLACEHOLDER',
      },
      adminUser(),
    );
    return { project, record };
  }

  const samplePdf = (size = 100): Buffer => Buffer.alloc(size, 0x25); // %

  it('createAttachment: 成功;listAttachments 不含 data;审计同事务', async () => {
    const { record } = await seedRecord('CREATE');
    const meta = await createAttachment(
      record.id,
      { name: '发票.pdf', type: 'application/pdf', size: 100, buffer: samplePdf() },
      adminUser(),
    );
    expect(meta.fileName).toBe('发票.pdf');
    expect(meta.sizeBytes).toBe(100);
    expect(meta.uploadedBy).toMatchObject({ id: adminId });

    const list = await listAttachments(record.id, adminUser());
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(meta.id);
    // AttachmentMeta 不应携带 data 字段。
    expect((list[0] as unknown as Record<string, unknown>).data).toBeUndefined();

    const audit = await prisma.auditLog.findFirst({
      where: {
        objectId: meta.id,
        action: 'record_attachment_upload',
        objectType: 'record_attachments',
      },
    });
    expect(audit).not.toBeNull();
  });

  it('createAttachment: 超 50MB → 413', async () => {
    const { record } = await seedRecord('BIG');
    await expect(
      createAttachment(
        record.id,
        {
          name: 'big.pdf',
          type: 'application/pdf',
          size: MAX_ATTACHMENT_BYTES_DEFAULT + 1,
          buffer: samplePdf(),
        },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('createAttachment: 非白名单类型 → 415', async () => {
    const { record } = await seedRecord('TYPE');
    await expect(
      createAttachment(
        record.id,
        { name: 'a.exe', type: 'application/x-msdownload', size: 10, buffer: samplePdf() },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('createAttachment: 记录不存在 → 404', async () => {
    await expect(
      createAttachment(
        uuidv7(),
        { name: 'a.pdf', type: 'application/pdf', size: 10, buffer: samplePdf() },
        adminUser(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('getAttachmentData: 返回 data 与上传一致', async () => {
    const { record } = await seedRecord('GET');
    const buf = Buffer.from('HELLO-ATTACHMENT');
    const meta = await createAttachment(
      record.id,
      { name: 'r.bin', type: 'application/pdf', size: buf.length, buffer: buf },
      adminUser(),
    );
    const { data } = await getAttachmentData(meta.id, adminUser());
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.equals(buf)).toBe(true);
  });

  it('deleteAttachment: 物理删除;留 delete 审计', async () => {
    const { record } = await seedRecord('DEL');
    const meta = await createAttachment(
      record.id,
      { name: 'd.pdf', type: 'application/pdf', size: 10, buffer: samplePdf() },
      adminUser(),
    );
    await deleteAttachment(meta.id, adminUser());
    const still = await prisma.recordAttachment.findUnique({ where: { id: meta.id } });
    expect(still).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: meta.id, action: 'record_attachment_delete' },
    });
    expect(audit).not.toBeNull();
  });

  it('权限:非成员 createAttachment → 403;但可 listAttachments(全局只读)', async () => {
    const { record } = await seedRecord('PERM');
    // USER 全局只读:listAttachments 走 project:view,允许。
    const list = await listAttachments(record.id, outsiderUser());
    expect(Array.isArray(list)).toBe(true);
    // createAttachment 走 record:edit,非项目成员 → 403。
    await expect(
      createAttachment(
        record.id,
        { name: 'a.pdf', type: 'application/pdf', size: 10, buffer: samplePdf() },
        outsiderUser(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('listForExport: 按年度过滤,返回 record + meta + data', async () => {
    const { project, record } = await seedRecord('EXPORT');
    await createAttachment(
      record.id,
      { name: 'e1.pdf', type: 'application/pdf', size: 5, buffer: Buffer.from('E1') },
      adminUser(),
    );
    const rows = await listForExport(project.id, { budgetYear: 2026 }, adminUser());
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const hit = rows.find((r) => r.attachment.fileName === 'e1.pdf');
    expect(hit).toBeTruthy();
    expect(hit!.record.summary).toContain('附件测试-EXPORT');
    expect(Buffer.isBuffer(hit!.data)).toBe(true);
    // 年度不匹配 → 不含。
    const none = await listForExport(project.id, { budgetYear: 2099 }, adminUser());
    expect(none.find((r) => r.attachment.fileName === 'e1.pdf')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/server/recordAttachment.service.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现服务层**

创建 `src/server/services/recordAttachment.service.ts`：

```ts
import { Prisma, User } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { uuidv7 } from '@/lib/id';
import { recordAudit } from '@/server/audit/interceptor';
import {
  MAX_ATTACHMENT_BYTES_DEFAULT,
  validateAttachment,
} from '@/lib/attachments/config';

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
    include: { uploadedBy: { select: { id: true; name: true } } },
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
    include: { record: { select: { projectId: true } }, uploadedBy: { select: { id: true, name: true } } },
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
      include: { uploadedBy: { select: { id: true; name: true } } },
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
export async function deleteAttachment(
  id: string,
  user: Pick<User, 'id' | 'role'>,
): Promise<void> {
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/server/recordAttachment.service.test.ts`
Expected: PASS（全部 8 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/server/services/recordAttachment.service.ts tests/server/recordAttachment.service.test.ts
git commit -m "feat(attachments): 附件服务层(CRUD + 校验 + 权限 + 审计 + 批量导出)"
```

---

## Task 4: CRUD API 路由（上传/列表/下载/删除）

**Files:**

- Create: `src/app/api/projects/[id]/records/[recordId]/attachments/route.ts`
- Create: `src/app/api/projects/[id]/records/[recordId]/attachments/[attId]/route.ts`
- Test: `tests/api/attachments.route.test.ts`

**Interfaces:**

- Consumes: Task 3 服务层全部函数；`requireUser`（`@/lib/auth/session`）；`HTTPError`
- Produces:
  - `POST   /api/projects/[id]/records/[recordId]/attachments` → 201 `{ ...AttachmentMeta }`
  - `GET    /api/projects/[id]/records/[recordId]/attachments` → 200 `{ attachments: AttachmentMeta[] }`
  - `GET    /api/projects/[id]/records/[recordId]/attachments/[attId]` → 200 binary（`Content-Disposition: attachment`）
  - `DELETE /api/projects/[id]/records/[recordId]/attachments/[attId]` → 204

- [ ] **Step 1: 写失败测试 — 路由集成测试**

> 说明：项目现有集成测试直连服务层（无 HTTP 起服务），路由测试同样以服务层 + NextResponse 行为为锚。这里测路由模块导出的 `POST/GET/DELETE` 函数对伪造 Request 的处理。先建测试目录占位。

创建 `tests/api/attachments.route.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { createRecord } from '@/server/services/businessRecord.service';
import {
  POST as uploadPost,
  GET as listGet,
} from '@/app/api/projects/[id]/records/[recordId]/attachments/route';
import {
  GET as downloadGet,
  DELETE as attDelete,
} from '@/app/api/projects/[id]/records/[recordId]/attachments/[attId]/route';

// mock 鉴权:所有 requireUser() 返回 admin。
vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/session')>)();
  return {
    ...actual,
    requireUser: async () => ({ id: MOCK_ADMIN_ID, role: UserRole.ADMIN, name: 'admin' }) as never,
  };
});

let MOCK_ADMIN_ID: string;

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.recordAttachment.deleteMany({ where: { record: { projectId } } }).catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('attachments API routes (integration)', () => {
  const createdProjectIds: string[] = [];
  let projectId: string;
  let recordId: string;

  beforeAll(async () => {
    await prisma.$connect();
    MOCK_ADMIN_ID = uuidv7();
    await prisma.user.create({
      data: { id: MOCK_ADMIN_ID, name: 'admin-route', role: UserRole.ADMIN },
    });
    const project = await createProject(
      { code: `RT-${uuidv7().slice(0, 8)}`, name: 'route test' },
      { id: MOCK_ADMIN_ID, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    projectId = project.id;
    const subject = await prisma.budgetSubject.findFirst({ where: { projectId, isLeaf: true } });
    if (!subject) throw new Error('夹具:无叶科目');
    const { record } = await createRecord(
      projectId,
      {
        budgetYear: 2026,
        subjectId: subject.id,
        amount: '10.00',
        businessDate: '2026-08-05',
        handler: 'x',
        summary: 'route',
        status: 'PLACEHOLDER',
      },
      { id: MOCK_ADMIN_ID, role: UserRole.ADMIN },
    );
    recordId = record.id;
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    await prisma.user.deleteMany({ where: { id: MOCK_ADMIN_ID } }).catch(() => {});
    await prisma.$disconnect();
  });

  function makeUploadReq(file: { name: string; type: string; bytes: Buffer }) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    return new Request(
      `http://localhost/api/projects/${projectId}/records/${recordId}/attachments`,
      {
        method: 'POST',
        body: form,
      },
    ) as never; // NextRequest 兼容
  }

  it('上传 → 列表 → 下载(bytea 一致)→ 删除 → 列表为空', async () => {
    // 上传。
    const payload = Buffer.from('INVOICE-CONTENT');
    const res1 = await uploadPost(
      makeUploadReq({ name: '发票.pdf', type: 'application/pdf', bytes: payload }),
      {
        params: Promise.resolve({ id: projectId, recordId }),
      } as never,
    );
    expect(res1.status).toBe(201);
    const meta = await res1.json();
    expect(meta.fileName).toBe('发票.pdf');

    // 列表。
    const res2 = await listGet(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments`,
      ) as never,
      {
        params: Promise.resolve({ id: projectId, recordId }),
      } as never,
    );
    expect(res2.status).toBe(200);
    const list = await res2.json();
    expect(list.attachments.length).toBe(1);

    // 下载:Content-Disposition 含文件名;body 字节一致。
    const res3 = await downloadGet(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments/${meta.id}`,
      ) as never,
      { params: Promise.resolve({ id: projectId, recordId, attId: meta.id }) } as never,
    );
    expect(res3.status).toBe(200);
    expect(res3.headers.get('Content-Disposition')).toContain('attachment');
    const dl = Buffer.from(await res3.arrayBuffer());
    expect(dl.equals(payload)).toBe(true);

    // 删除。
    const res4 = await attDelete(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments/${meta.id}`,
        { method: 'DELETE' },
      ) as never,
      { params: Promise.resolve({ id: projectId, recordId, attId: meta.id }) } as never,
    );
    expect(res4.status).toBe(204);

    // 列表为空。
    const res5 = await listGet(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments`,
      ) as never,
      {
        params: Promise.resolve({ id: projectId, recordId }),
      } as never,
    );
    const list2 = await res5.json();
    expect(list2.attachments.length).toBe(0);
  });

  it('上传非文件字段 → 400', async () => {
    const form = new FormData();
    form.append('file', 'not-a-file');
    const res = await uploadPost(
      new Request(`http://localhost/api/projects/${projectId}/records/${recordId}/attachments`, {
        method: 'POST',
        body: form,
      }) as never,
      { params: Promise.resolve({ id: projectId, recordId }) } as never,
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/api/attachments.route.test.ts`
Expected: FAIL（路由模块不存在）。

- [ ] **Step 3: 实现上传 + 列表路由**

创建 `src/app/api/projects/[id]/records/[recordId]/attachments/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { createAttachment, listAttachments } from '@/server/services/recordAttachment.service';

/**
 * POST /api/projects/:id/records/:recordId/attachments — 上传单个报销凭证附件。
 * 接受 multipart/form-data(file 字段)。
 * 权限/校验/审计在服务层。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  try {
    const user = await requireUser();
    const { recordId } = await params;

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少上传文件(file 字段)' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const meta = await createAttachment(
      recordId,
      { name: file.name, type: file.type || 'application/octet-stream', size: file.size, buffer },
      user,
    );
    return NextResponse.json(meta, { status: 201 });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/**
 * GET /api/projects/:id/records/:recordId/attachments — 列出该记录的附件元数据(不含二进制)。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  try {
    const user = await requireUser();
    const { recordId } = await params;
    const attachments = await listAttachments(recordId, user);
    return NextResponse.json({ attachments });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
```

- [ ] **Step 4: 实现下载 + 删除路由**

创建 `src/app/api/projects/[id]/records/[recordId]/attachments/[attId]/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';

import { HTTPError, requireUser } from '@/lib/auth/session';
import { deleteAttachment, getAttachmentData } from '@/server/services/recordAttachment.service';

/**
 * GET /api/projects/:id/records/:recordId/attachments/:attId — 下载附件二进制。
 * Content-Disposition: attachment; filename*=UTF-8''<encoded>(支持中文文件名)。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string; attId: string }> },
) {
  try {
    const user = await requireUser();
    const { attId } = await params;
    const { meta, data } = await getAttachmentData(attId, user);
    // RFC 5987 编码中文文件名。
    const encoded = encodeURIComponent(meta.fileName)
      .replace(/['()]/g, escape)
      .replace(/\*/g, '%2A');
    return new NextResponse(data as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': meta.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
        'Content-Length': String(meta.sizeBytes),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** DELETE /api/projects/:id/records/:recordId/attachments/:attId — 删除附件(物理删除 + 审计)。 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string; attId: string }> },
) {
  try {
    const user = await requireUser();
    const { attId } = await params;
    await deleteAttachment(attId, user);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/api/attachments.route.test.ts`
Expected: PASS。

- [ ] **Step 6: 实测大文件 body 上限（风险验证）**

写一个临时脚本（不提交）测 30MB 上传是否被 Next 拒：

```bash
cat > /tmp/big-upload-test.mjs <<'EOF'
// 手动:启动 dev(npm run dev)后,用 curl 上传一个 30MB 文件到某记录。
// 生成 30MB 文件:
import { writeFileSync } from 'node:fs';
const buf = Buffer.alloc(30 * 1024 * 1024, 0x41);
writeFileSync('/tmp/big30.pdf', buf);
EOF
node /tmp/big-upload-test.mjs
# 替换 <RECORD_ID> 为数据库里任一业务记录 id:
curl -i -X POST "http://localhost:3000/api/projects/<PROJ_ID>/records/<RECORD_ID>/attachments" \
  -H "x-mock-user-id: <ADMIN_ID>" -F "file=@/tmp/big30.pdf"
```

观察返回状态：

- **201** → 默认上限够，50MB 方案无需额外配置。
- **413 / 500(body too large)** → 在 Task 4 路由顶部或 `next.config.ts` 处理。Next 16 App Router 若报 body limit，记录实测阈值，并在 spec §7 风险中更新"实际可用上限"。此步的结论写入提交说明，**不阻塞** Task 5+。

- [ ] **Step 7: Commit**

```bash
git add src/app/api/projects/[id]/records/[recordId]/attachments/ tests/api/attachments.route.test.ts
git commit -m "feat(attachments): 上传/列表/下载/删除 API 路由"
```

---

## Task 5: 批量导出 API（zip）

**Files:**

- Create: `src/app/api/projects/[id]/attachments/export/route.ts`
- Modify: `tests/api/attachments.route.test.ts`（追加导出用例）

**Interfaces:**

- Consumes: `listForExport`（Task 3）、`requireUser`、`HTTPError`、`jszip`（已是依赖）、`prisma.project.findUnique`（取项目名）
- Produces: `GET /api/projects/[id]/attachments/export?budgetYear=&subjectId=` → 200 `application/zip`（`Content-Disposition: attachment`）；无附件 → 404。

- [ ] **Step 1: 追加失败测试 — 导出**

在 `tests/api/attachments.route.test.ts` 末尾追加（在最后一个 `it` 之后、`describe` 结束 `});` 之前）：

```ts
it('导出:有附件返回 zip;无附件返回 404', async () => {
  const { GET: exportGet } = await import('@/app/api/projects/[id]/attachments/export/route');
  // 先上传一个附件用于导出。
  const payload = Buffer.from('ZIP-CONTENT');
  const up = await uploadPost(
    makeUploadReq({ name: 'z.pdf', type: 'application/pdf', bytes: payload }),
    {
      params: Promise.resolve({ id: projectId, recordId }),
    } as never,
  );
  expect(up.status).toBe(201);

  const res = await exportGet(
    new Request(
      `http://localhost/api/projects/${projectId}/attachments/export?budgetYear=2026`,
    ) as never,
    { params: Promise.resolve({ id: projectId }) } as never,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('application/zip');
  expect(res.headers.get('Content-Disposition')).toContain('attachment');
  // body 非空(zip 字节)。
  const buf = Buffer.from(await res.arrayBuffer());
  expect(buf.length).toBeGreaterThan(0);
  // zip 魔数 PK\x03\x04。
  expect(buf[0]).toBe(0x50);
  expect(buf[1]).toBe(0x4b);

  // 无附件范围(2099 年)→ 404。
  const none = await exportGet(
    new Request(
      `http://localhost/api/projects/${projectId}/attachments/export?budgetYear=2099`,
    ) as never,
    { params: Promise.resolve({ id: projectId }) } as never,
  );
  expect(none.status).toBe(404);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/api/attachments.route.test.ts`
Expected: FAIL（export 路由不存在）。

- [ ] **Step 3: 实现导出路由**

创建 `src/app/api/projects/[id]/attachments/export/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { listForExport } from '@/server/services/recordAttachment.service';

/**
 * GET /api/projects/:id/attachments/export?budgetYear=&subjectId= — 批量打包导出附件 zip。
 * 沿用记录页筛选(年度/科目)。zip 内文件名:`<业务日期>_<摘要>_<原文件名>`(冲突追加序号)。
 * 无附件 → 404。权限:project:view(全局只读 USER 也可导出查阅)。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    const sp = req.nextUrl.searchParams;
    const budgetYear = sp.get('budgetYear') ? Number(sp.get('budgetYear')) : undefined;
    const subjectId = sp.get('subjectId') || undefined;

    const rows = await listForExport(projectId, { budgetYear, subjectId }, user);
    if (rows.length === 0) {
      return NextResponse.json({ error: '所选范围内无附件' }, { status: 404 });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });

    const zip = new JSZip();
    const used = new Map<string, number>(); // 去重计数
    for (const r of rows) {
      const date = r.record.businessDate.toISOString().slice(0, 10); // yyyy-mm-dd
      const safeSummary = (r.record.summary || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const base = `${date}_${safeSummary}_${r.attachment.fileName}`.replace(/\s+/g, '_');
      let name = base;
      const count = used.get(base) ?? 0;
      if (count > 0) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? `${base.slice(0, dot)}(${count})${base.slice(dot)}` : `${base}(${count})`;
      }
      used.set(base, count + 1);
      zip.file(name, r.data);
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const projectName = project?.name ?? projectId;
    const zipName = encodeURIComponent(
      `附件_${projectName}${budgetYear ? `_${budgetYear}` : ''}.zip`,
    );
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${zipName}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/api/attachments.route.test.ts`
Expected: PASS（含新增导出用例）。

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/[id]/attachments/export/route.ts tests/api/attachments.route.test.ts
git commit -m "feat(attachments): 批量打包导出附件 zip(按项目/年度/科目)"
```

---

## Task 6: 环境变量配置

**Files:**

- Modify: `src/lib/env.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes: Task 2 的 `MAX_ATTACHMENT_BYTES_DEFAULT`、`ALLOWED_ATTACHMENT_SPEC`
- Produces: `env.MAX_ATTACHMENT_BYTES`（number，默认 50MB）、`env.ALLOWED_ATTACHMENT_TYPES`（运行期可覆盖的白名单，默认即 spec）。**注意：Task 3 服务层当前直接用 `MAX_ATTACHMENT_BYTES_DEFAULT`；本任务把上限改成读 `env.MAX_ATTACHMENT_BYTES`，让运维可调。**

> 决策：为保持改动聚焦，本任务只接入 `MAX_ATTACHMENT_BYTES`（最常被运维调整的项）。类型白名单保持代码内常量（`ALLOWED_ATTACHMENT_SPEC`），因为通过 env 传结构化数据（扩展名+MIME 数组）需要 JSON 编码，收益低、易错。

- [ ] **Step 1: 修改 env.ts — 加 MAX_ATTACHMENT_BYTES**

在 `src/lib/env.ts` 的 `APP_BASE_URL` 字段后追加：

```ts
    /** 对外基础 URL,用于拼 OIDC redirect_uri / 登出回跳。 */
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** 附件单文件大小上限(字节,默认 50MB)。 */
    MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
```

- [ ] **Step 2: 修改服务层 — 用 env 替代默认常量**

在 `src/server/services/recordAttachment.service.ts`：

- import 改为：`import { env } from '@/lib/env';`，并把 `validateAttachment` 的 import 保留（不再 import `MAX_ATTACHMENT_BYTES_DEFAULT`，但保留以备测试）。
- `createAttachment` 内调用改为：

  ```ts
  const verdict = validateAttachment(
    { name: file.name, type: file.type, size: file.size },
    env.MAX_ATTACHMENT_BYTES,
  );
  ```

- [ ] **Step 3: 修改 .env.example — 补注释**

在 `.env.example` 的 SSO 相关变量块**之后**、文件末尾追加（注意：当前 `.env.example` 有未提交的局域网注释改动，本步骤只在文件末尾追加，不动既有内容）：

```bash

# 附件(报销凭证)上传配置
# 单文件大小上限(字节);默认 50MB,超过会被服务端拒绝(413)。
# MAX_ATTACHMENT_BYTES=52428800
# 允许的文件类型在代码内维护(src/lib/attachments/config.ts),如需调整改代码。
```

- [ ] **Step 4: 验证启动校验与测试**

Run:

```bash
npm run check-types
npx vitest run tests/server/recordAttachment.service.test.ts tests/lib/attachments/config.test.ts
```

Expected: 类型检查 PASS；测试仍 PASS（默认值未变，行为一致）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/env.ts src/server/services/recordAttachment.service.ts .env.example
git commit -m "feat(attachments): MAX_ATTACHMENT_BYTES 走 env 配置(默认 50MB)"
```

---

## Task 7: 客户端附件 API 工具

**Files:**

- Create: `src/lib/api/attachments.ts`

**Interfaces:**

- Consumes: `bootstrapMockUser`、`downloadFile`（`@/lib/api/client`）；服务层 `AttachmentMeta` 形状（客户端自定同名类型，避免服务端类型泄漏到客户端 bundle）
- Produces:
  - `export interface AttachmentMeta { id; recordId; fileName; contentType; sizeBytes; uploadedBy: { id; name }; createdAt: string }`
  - `listAttachments(projectId, recordId): Promise<AttachmentMeta[]>`
  - `uploadAttachment(projectId, recordId, file): Promise<AttachmentMeta>`
  - `deleteAttachment(projectId, recordId, attId): Promise<void>`
  - `downloadAttachment(projectId, recordId, attId): Promise<void>`（复用 `downloadFile`）
  - `exportAttachmentsZip(projectId, query): Promise<void>`（复用 `downloadFile`）

- [ ] **Step 1: 实现客户端工具**

创建 `src/lib/api/attachments.ts`：

```ts
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
```

- [ ] **Step 2: 类型检查**

Run: `npm run check-types`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/attachments.ts
git commit -m "feat(attachments): 客户端上传/下载/列表/删除/导出封装"
```

---

## Task 8: 附件侧边抽屉组件（独立查看/补充/删除）

**Files:**

- Create: `src/components/records/AttachmentSheet.tsx`

**Interfaces:**

- Consumes: Task 7 客户端工具；shadcn `Sheet`、`Button`、`Skeleton`；`sonner` toast；`humanFileSize`（Task 2）；`canWriteRecords` 来自父级传入
- Produces: 默认导出 `AttachmentSheet` 组件，props：

  ```ts
  {
    projectId: string;
    record: { id: string; summary: string; handler: string; amount: string; businessDate: string; isVoid: boolean } | null;
    canWrite: boolean;       // 是否可上传/删除(=项目 canWriteRecords)
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }
  ```

- [ ] **Step 1: 实现组件**

创建 `src/components/records/AttachmentSheet.tsx`：

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Paperclip, Download, Trash2, Plus, FileWarning } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AttachmentMeta,
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  uploadAttachment,
} from '@/lib/api/attachments';
import { humanFileSize } from '@/lib/attachments/config';

interface AttachmentSheetProps {
  projectId: string;
  record: {
    id: string;
    summary: string;
    handler: string;
    amount: string;
    businessDate: string;
    isVoid: boolean;
  } | null;
  canWrite: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PendingItem {
  file: File;
  status: 'uploading' | 'done' | 'error';
  message?: string;
}

const MAX_CLIENT_BYTES = 50 * 1024 * 1024; // 客户端预拦截(与服务端一致)
const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx';

export function AttachmentSheet({
  projectId,
  record,
  canWrite,
  open,
  onOpenChange,
}: AttachmentSheetProps) {
  const [items, setItems] = useState<AttachmentMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时拉取该记录的附件。
  useEffect(() => {
    if (!open || !record) return;
    let cancelled = false;
    setLoading(true);
    listAttachments(projectId, record.id)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : '加载附件失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, record, projectId]);

  if (!record) return null;

  const readonly = !canWrite || record.isVoid;

  const handleFiles = async (files: FileList | File[]) => {
    if (!record || readonly) return;
    const arr = Array.from(files);
    // 客户端预校验:超 50MB 直接拦截。
    const tooBig = arr.find((f) => f.size > MAX_CLIENT_BYTES);
    if (tooBig) {
      toast.error(`文件过大(上限 50MB):${tooBig.name}`);
      return;
    }
    setPending((prev) => [
      ...prev,
      ...arr.map<PendingItem>((f) => ({ file: f, status: 'uploading' })),
    ]);
    for (const file of arr) {
      try {
        const meta = await uploadAttachment(projectId, record.id, file);
        setItems((prev) => [...prev, meta]);
        setPending((prev) => prev.map((p) => (p.file === file ? { ...p, status: 'done' } : p)));
      } catch (e) {
        setPending((prev) =>
          prev.map((p) =>
            p.file === file
              ? { ...p, status: 'error', message: e instanceof Error ? e.message : '上传失败' }
              : p,
          ),
        );
      }
    }
    // 1.5s 后清掉已完成的 pending(保留 error 项供重试/查看)。
    setTimeout(() => {
      setPending((prev) => prev.filter((p) => p.status !== 'done'));
    }, 1500);
  };

  const handleDelete = async (att: AttachmentMeta) => {
    try {
      await deleteAttachment(projectId, record.id, att.id);
      setItems((prev) => prev.filter((x) => x.id !== att.id));
      toast.success('已删除附件');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Paperclip className="size-4" />
            报销凭证
          </SheetTitle>
          <SheetDescription>
            {record.summary} · {record.handler} · ¥{record.amount} · {record.businessDate}
            {record.isVoid ? ' · 已作废' : ''}
          </SheetDescription>
        </SheetHeader>

        {/* 上传区(只读时隐藏) */}
        {!readonly && (
          <label
            className={cn(
              'mt-4 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed bg-card px-4 py-8 text-center transition-colors',
              dragOver ? 'border-ring bg-accent/60' : 'border-hairline-strong hover:border-ring',
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
            }}
          >
            <Plus className="size-6 text-mute" />
            <p className="text-sm">点击或拖拽文件到此处上传</p>
            <p className="text-xs text-mute">支持图片 / PDF / Office 文档,单文件 ≤ 50MB</p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        )}

        {/* 已上传列表 */}
        <div className="mt-4 flex-1 space-y-2 overflow-y-auto">
          {loading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <>
              {items.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-2 rounded-md border border-hairline bg-card px-3 py-2"
                >
                  <Paperclip className="size-4 shrink-0 text-mute" />
                  <span className="flex-1 truncate text-sm" title={att.fileName}>
                    {att.fileName}
                  </span>
                  <span className="shrink-0 text-xs text-mute">{humanFileSize(att.sizeBytes)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="下载"
                    onClick={() =>
                      downloadAttachment(projectId, record.id, att.id).catch((e: unknown) =>
                        toast.error(e instanceof Error ? e.message : '下载失败'),
                      )
                    }
                  >
                    <Download className="size-4" />
                  </Button>
                  {canWrite && !record.isVoid && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-error-deep hover:text-error-deep"
                      aria-label="删除"
                      onClick={() => void handleDelete(att)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
              {/* pending(上传中/失败) */}
              {pending.map((p, i) => (
                <div
                  key={`${p.file.name}-${i}`}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-3 py-2',
                    p.status === 'error'
                      ? 'border-error text-error-deep'
                      : 'border-hairline bg-card',
                  )}
                >
                  {p.status === 'error' ? (
                    <FileWarning className="size-4 shrink-0" />
                  ) : (
                    <Paperclip className="size-4 shrink-0 animate-pulse text-mute" />
                  )}
                  <span className="flex-1 truncate text-sm" title={p.file.name}>
                    {p.file.name}
                  </span>
                  <span className="shrink-0 text-xs">
                    {p.status === 'uploading' ? '上传中…' : (p.message ?? '失败')}
                  </span>
                </div>
              ))}
              {items.length === 0 && pending.length === 0 && !loading && (
                <p className="py-6 text-center text-sm text-mute">暂无附件</p>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: 类型检查 + lint**

Run: `npm run check-types && npm run lint`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/components/records/AttachmentSheet.tsx
git commit -m "feat(attachments): 附件侧边抽屉组件(拖拽上传/列表/下载/删除)"
```

---

## Task 9: 记录页集成 — 表格附件徽标 + 抽屉 + 工具栏导出

**Files:**

- Modify: `src/app/(dashboard)/projects/[id]/records/page.tsx`（表格 columns 约 line 534、RowActions 约 line 488、工具栏区域、`BusinessRecordRow` interface 约 line 122）

**Interfaces:**

- Consumes: Task 8 `AttachmentSheet`；Task 7 `exportAttachmentsZip`；`project.canWriteRecords`（页面已有）；lucide `Paperclip`
- Produces: 记录表格新增「附件」徽标列（点击打开抽屉）；工具栏新增「导出附件(zip)」按钮；记录行 `BusinessRecordRow` 增加 `attachmentCount?: number`（列表 API 已含则用，否则按需扩展——见 Step 1 决策）。

> **决策（attachmentCount 数据来源）**：为避免改动现有 `listRecords` 服务层与 SQL，前端在打开抽屉时才加载附件数量；表格徽标**不显示具体数量**，只显示有无（`📎` 实色=有、灰色=未知/无）。这样 Task 9 完全不碰 records 服务层。若后续要显示精确数量，可在 `listRecords` 加 `include: { _count: { select: { attachments: true } } }`，作为后续优化，不在本计划范围。

- [ ] **Step 1: 给 records 页面加 import 与状态**

在 `src/app/(dashboard)/projects/[id]/records/page.tsx` 顶部 import 区追加：

```ts
import { Paperclip, Package } from 'lucide-react';
import { AttachmentSheet } from '@/components/records/AttachmentSheet';
import { exportAttachmentsZip } from '@/lib/api/attachments';
```

在 `BusinessRecordsPageInner` 组件内（与现有 `voidTarget`/`historyTarget` 等状态同级）追加抽屉状态：

```ts
const [attachmentTarget, setAttachmentTarget] = useState<BusinessRecordRow | null>(null);
```

- [ ] **Step 2: 在 columns 中新增「附件」列**

在 `const columns = useMemo<ColumnDef<BusinessRecordRow>[]>(...`（约 line 534）的列数组中，**在操作列之前**插入一列。先定位现有最后一列（通常是行内操作 `RowActions`），在其前插入：

```tsx
        {
          id: 'attachments',
          header: '附件',
          cell: ({ row }) => (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-mute"
              onClick={() => setAttachmentTarget(row.original)}
              aria-label="查看报销凭证"
            >
              <Paperclip className="size-4" />
            </Button>
          ),
          enableSorting: false,
          enableHiding: false,
        },
```

- [ ] **Step 3: 工具栏新增「导出附件」按钮**

定位页面工具栏（含「导入 Excel」/「导出」按钮的区域，通常在 `return (` 后的顶部 Card/Header 附近）。在现有「导出」按钮旁边追加：

```tsx
<Button
  variant="outline"
  size="sm"
  onClick={() =>
    exportAttachmentsZip(projectId, {
      budgetYear: yearFilter ? Number(yearFilter) : undefined,
      subjectId: subjectFilter || undefined,
    }).catch((e: unknown) => toast.error(e instanceof Error ? e.message : '导出失败'))
  }
>
  <Package className="size-4" />
  导出附件(zip)
</Button>
```

> 说明：`yearFilter` / `subjectFilter` 是页面已有的筛选状态变量名（实现时按实际变量名对齐——它们在 `HeaderFilter` 的 value 中）。若变量名不同，使用页面内已有的年度/科目筛选状态。实现时确认现有筛选状态变量名后再写入，**不要臆造变量**。

- [ ] **Step 4: 在 JSX 末尾挂载 AttachmentSheet**

定位页面 `return` 内最后一个 Sheet/Dialog 之后（如 history Sheet 之后、闭合 `</div>` 之前），追加：

```tsx
<AttachmentSheet
  projectId={projectId}
  record={
    attachmentTarget
      ? {
          id: attachmentTarget.id,
          summary: attachmentTarget.summary,
          handler: attachmentTarget.handler,
          amount: attachmentTarget.amount,
          businessDate: attachmentTarget.businessDate,
          isVoid: attachmentTarget.isVoid,
        }
      : null
  }
  canWrite={!!project?.canWriteRecords}
  open={!!attachmentTarget}
  onOpenChange={(o) => !o && setAttachmentTarget(null)}
/>
```

- [ ] **Step 5: 确认筛选变量名并修正 Step 3**

实现时打开 `records/page.tsx`，搜索 `HeaderFilter` 与年度/科目筛选的 `useState`，用真实变量名替换 Step 3 中的 `yearFilter` / `subjectFilter`。若筛选是 URL searchParams 形态，则从 `search.get('year')` / `search.get('subjectId')` 取值。

- [ ] **Step 6: 类型检查 + lint**

Run: `npm run check-types && npm run lint`
Expected: PASS。

- [ ] **Step 7: 浏览器手动验证**

Run: `npm run dev`

1. 选一个项目 → 进入「业务记录」页
2. 点某行「📎」→ 抽屉打开 → 拖一个 PDF → 列表出现 → 下载 → 删除
3. 上传一个 .exe → 期望 toast 报「不支持的文件类型」（服务端 415）
4. 工具栏「导出附件(zip)」→ 浏览器下载 zip，解压能看到刚传的文件
5. 作废一条记录 → 抽屉打开时上传区应隐藏、删除按钮不显示

- [ ] **Step 8: Commit**

```bash
git add src/app/(dashboard)/projects/[id]/records/page.tsx
git commit -m "feat(attachments): 记录页附件徽标列 + 抽屉 + 工具栏批量导出"
```

---

## Task 10: 创建/编辑表单内附带附件

**Files:**

- Modify: `src/app/(dashboard)/projects/[id]/records/page.tsx`（`recordSchema` 约 line 193、`submitForm` 约 line 362、表单 Dialog JSX）

**Interfaces:**

- Consumes: Task 7 `uploadAttachment`；`form`（react-hook-form，页面已有）
- Produces: 表单提交后若有 `pendingFiles`，循环上传；部分失败不回滚业务。

- [ ] **Step 1: 加 pendingFiles 状态（表单外临时态，不进 zod schema）**

在 `BusinessRecordsPageInner` 内（与 `attachmentTarget` 同级）追加：

```ts
const [pendingFiles, setPendingFiles] = useState<File[]>([]);
```

- [ ] **Step 2: 改造 submitForm — 业务保存成功后循环上传附件**

修改 `submitForm`（约 line 362）。在现有 `try` 块内、`await reloadRecords();` **之前**，且在拿到新建/编辑成功的分支之后，插入附件上传逻辑。

把整个 `submitForm` 函数体替换为（保留原有 payload 构造与 apiFetch 逻辑，仅在成功后加附件循环 + finally 重置 pendingFiles）：

```ts
const submitForm = (keepOpen: boolean) =>
  form.handleSubmit(async (values) => {
    const payload = {
      budgetYear: values.budgetYear,
      subjectId: values.subjectId,
      amount: values.amount,
      businessDate: format(values.businessDate, 'yyyy-MM-dd'),
      handler: values.handler,
      summary: values.summary,
      status: values.status,
      remark: values.remark || null,
    };
    setSubmitting(true);
    try {
      let savedRecordId = editing?.id ?? '';
      if (editing) {
        const res = await apiFetch<{ record: BusinessRecordRow; overBudget: boolean }>(
          `/api/projects/${projectId}/records/${editing.id}`,
          { method: 'PATCH', body: JSON.stringify(payload) },
        );
        toast.success('已保存修改');
        if (res.overBudget) setOverBudgetOpen(true);
        setFormOpen(false);
      } else {
        const res = await apiFetch<{ record: BusinessRecordRow; overBudget: boolean }>(
          `/api/projects/${projectId}/records`,
          { method: 'POST', body: JSON.stringify(payload) },
        );
        toast.success('已新增业务记录');
        if (res.overBudget) setOverBudgetOpen(true);
        savedRecordId = res.record.id;
        if (keepOpen) {
          form.reset({
            budgetYear: values.budgetYear,
            subjectId: values.subjectId,
            amount: undefined,
            businessDate: values.businessDate,
            handler: values.handler,
            summary: '',
            status: values.status,
            remark: '',
          });
          form.setFocus('amount');
        } else {
          setFormOpen(false);
        }
      }

      // —— 附件:业务已保存成功后,循环上传 pendingFiles。失败不回滚业务。 ——
      if (pendingFiles.length > 0 && savedRecordId) {
        const failed: string[] = [];
        for (const file of pendingFiles) {
          try {
            await uploadAttachment(projectId, savedRecordId, file);
          } catch {
            failed.push(file.name);
          }
        }
        if (failed.length === 0) {
          toast.success(`已上传 ${pendingFiles.length} 个附件`);
        } else {
          toast.error(
            `业务已保存,但 ${failed.length} 个附件上传失败:${failed.join(', ')}(可在附件抽屉重试)`,
          );
        }
        setPendingFiles([]);
      }

      await reloadRecords();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  })();
```

> 确认 import：Step 1（Task 9）已 import `exportAttachmentsZip`；本步骤需额外确保 `uploadAttachment` 已 import。检查顶部 import 是否含 `import { exportAttachmentsZip, uploadAttachment } from '@/lib/api/attachments';`，没有则补全。

- [ ] **Step 3: 在表单 Dialog 内加「报销凭证」区块**

定位表单 Dialog 内最后一个表单字段（`remark` 字段）之后、提交按钮（`submitForm` 按钮约 line 904-910）之前，插入附件区块 JSX：

```tsx
{
  /* 报销凭证(可选):表单提交成功后一并上传;不参与 zod 校验。 */
}
<div className="space-y-2">
  <div className="flex items-center justify-between">
    <FormLabel>报销凭证(可选)</FormLabel>
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        const el = document.createElement('input');
        el.type = 'file';
        el.multiple = true;
        el.accept = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
        el.onchange = () => {
          if (el.files) setPendingFiles((prev) => [...prev, ...Array.from(el.files!)]);
        };
        el.click();
      }}
    >
      选择文件
    </Button>
  </div>
  {pendingFiles.length === 0 ? (
    <p className="text-xs text-mute">未选择附件;保存业务后将一并上传</p>
  ) : (
    <ul className="space-y-1 rounded-md border border-hairline bg-card p-2">
      {pendingFiles.map((f, i) => (
        <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm">
          <Paperclip className="size-3.5 shrink-0 text-mute" />
          <span className="flex-1 truncate" title={f.name}>
            {f.name}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
          >
            ×
          </Button>
        </li>
      ))}
    </ul>
  )}
</div>;
```

> `FormLabel` 已是页面已有 import（react-hook-form + shadcn form）。`Paperclip` 在 Task 9 已 import。若编辑场景下需展示「已有附件」只读列表，可在区块顶部额外拉取（此处保持最小化：编辑时已有附件通过抽屉管理，表单内只处理"新增"——对齐 spec §3-A「只读」由抽屉承担）。

- [ ] **Step 4: 打开新建/编辑对话框时清空 pendingFiles**

定位打开新建对话框的逻辑（通常 `setFormOpen(true)` / `setEditing(null)` 处）与打开编辑的逻辑（`setEditing(row)` 处）。在两处分别追加 `setPendingFiles([])`，避免上次残留。

实现时搜索 `setEditing(` 出现的所有位置，在每个会打开 Dialog 的分支补 `setPendingFiles([])`。

- [ ] **Step 5: 类型检查 + lint**

Run: `npm run check-types && npm run lint`
Expected: PASS。

- [ ] **Step 6: 浏览器手动验证**

Run: `npm run dev`

1. 新建业务时选 1-2 个 PDF → 保存 → 期望 toast「已上传 N 个附件」→ 该行点📎能看到
2. 新建业务时选一个 .exe → 保存 → 期望 toast 报「业务已保存,但 1 个附件上传失败」→ 业务记录仍在
3. 编辑现有业务 → 选一个新附件 → 保存 → 抽屉里能看到新附件
4. 取消对话框重开 → pendingFiles 应已清空

- [ ] **Step 7: Commit**

```bash
git add src/app/(dashboard)/projects/[id]/records/page.tsx
git commit -m "feat(attachments): 业务表单内可选附带附件(先存业务后传附件,解耦)"
```

---

## Task 11: 全量验证与文档收尾

**Files:**

- Modify: `CHANGELOG.md`（新增版本节，发布时填版本号——但**不手改 package.json version**）

**Interfaces:**

- Consumes: 所有前序 Task
- Produces: 全绿测试 + lint + 类型 + build；CHANGELOG 草稿。

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含新增 config / service / route 测试，且现有测试无回归）。

- [ ] **Step 2: 类型 + lint + build**

Run:

```bash
npm run check-types
npm run lint
npm run build
```

Expected: 三项全 PASS；build 产物含新路由。

- [ ] **Step 3: CHANGELOG 草稿（不提交，待发版时由 npm version 流程一并提交）**

在 `CHANGELOG.md` 顶部（最新版本节之上）新增一节草稿。版本号暂用占位 `## [Unreleased]`，待与维护者确认后定 minor。内容：

```markdown
## [Unreleased]

### 新增

- **业务记录报销凭证附件**：每笔业务可上传报销凭证附件（图片 / PDF / Office 文档，单文件 ≤ 50MB，不限数量），便于后期整理经费报告。
  - 创建/编辑业务时可一并附带附件；已保存业务可在记录页「附件」抽屉中查看 / 补充 / 删除。
  - 支持按项目 / 年度 / 科目批量打包导出全部附件（zip）。
  - 附件以二进制存入数据库，随库备份；权限沿用业务记录编辑权（上传 / 删除）与项目查看权（列表 / 下载 / 导出）。
```

> **重要**：本步骤只写 CHANGELOG 草稿供维护者审阅，**不执行 `npm version`**（那是发版动作，按 AGENTS.md 在 `main` 上由维护者触发）。提交 CHANGELOG 草稿用单独 commit。

- [ ] **Step 4: 提交 CHANGELOG 草稿**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 附件功能草稿"
```

- [ ] **Step 5: 收尾汇报**

向维护者汇报：所有测试/类型/lint/build 通过；功能已在本地浏览器手动验证（上传/下载/删除/导出/表单附带/作废只读/权限拦截）；Task 4 Step 6 大文件实测结论（实际可用上限）；CHANGELOG 草稿已就位，待发版时定 minor 走 `npm version minor`。

---

## Notes for the Implementer

- **测试夹具依赖 `createProject` 自动建初始科目树**：`createProject`（`project.service.ts`）会建项目并植入默认叶科目，所以 `prisma.budgetSubject.findFirst({ where: { projectId, isLeaf: true } })` 总能取到。若某天 `createProject` 不再自动建科目，测试夹具需调整。
- **集成测试串行**：vitest 配 `singleFork: true`，所有测试文件串行；不要在测试里并发依赖全局状态。
- **mock requireUser 的方式**（Task 4）：用 `vi.mock('@/lib/auth/session', ...)` 覆盖 `requireUser`，保留 `HTTPError` 真实导出。`MOCK_ADMIN_ID` 必须在 mock 工厂闭包外用 `let` 声明，并在 `beforeAll` 内赋值（mock 工厂在模块求值时执行，此时读到的是 `undefined`，但 `requireUser` 是运行期调用，调用时 `MOCK_ADMIN_ID` 已赋值——这是合法的 JS 闭包行为）。
- **`makeUploadReq` 用 `Blob`**：Node 的 undici（Next 路由测试运行环境）支持 `Blob` + `FormData.append(name, blob, filename)`，无需 polyfill。
- **不要手改 `package.json` 的 `version`**：发版由 `npm version minor` 在 `main` 上完成。
- **Task 4 Step 6 大文件实测**是风险闭环点：若 Next 16 实际 body 上限 < 50MB，把实测值同步到 spec §7 风险表与 `MAX_ATTACHMENT_BYTES` 默认值（改 env 默认，不静默），并在 CHANGELOG 标注实际可用上限。
