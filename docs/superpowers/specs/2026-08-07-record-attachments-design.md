# 业务记录报销凭证附件 — 设计文档

- **日期**: 2026-08-07
- **状态**: 已确认设计，待实现
- **目标**: 每笔业务（`BusinessRecord`）可上传报销凭证附件，便于后期整理经费报告

## 决策摘要

| 维度      | 选择                                                              |
| --------- | ----------------------------------------------------------------- |
| 存储      | PostgreSQL `bytea` 列（文件二进制入库）                           |
| 上传时机  | 两种都要：业务表单内可选附带 + 已保存后独立抽屉补充               |
| 数量/大小 | 不限数量、不压缩；单文件硬上限 50MB（仅 OOM 防护）；UI 给体积提示 |
| 文件类型  | 图片 + PDF + Office 文档                                          |
| 导出      | 批量打包导出（按项目/年度/科目 zip）                              |
| UI 载体   | 嵌入业务创建/编辑表单 + 独立附件抽屉                              |

## 1. 数据模型与存储

### 新增 Prisma 模型

```prisma
model RecordAttachment {
  id            String   @id @db.Uuid          // uuidv7
  recordId      String   @map("record_id") @db.Uuid
  fileName      String                          // 原始文件名（用户可见）
  contentType   String   @map("content_type")  // MIME，如 image/png
  sizeBytes     Int      @map("size_bytes")     // 字节数
  data          Bytes                            // 文件二进制（bytea）
  uploadedById  String   @map("uploaded_by") @db.Uuid
  createdAt     DateTime @default(now()) @map("created_at")

  record       BusinessRecord @relation(fields: [recordId], references: [id], onDelete: Cascade)
  uploadedBy   User           @relation("AttachmentUploader", fields: [uploadedById], references: [id])

  @@index([recordId])
  @@map("record_attachments")
}
```

- `BusinessRecord` 增加 `attachments RecordAttachment[]` 反向关系
- `User` 增加 `uploadedAttachments RecordAttachment[] @relation("AttachmentUploader")` 反向关系
- `onDelete: Cascade` —— 物理删记录时附件随清（当前系统是逻辑作废 `isVoid`，不物理删，正常场景不会触发；真删时符合预期）
- **作废不清理附件**：作废（void）的业务记录保留附件，凭证可能仍需查阅
- 字段命名/审计风格对齐 `BusinessRecordHistory` 与 `ReceiptRecord`

### 存储策略

- 全部走 PostgreSQL `bytea`，单表集中
- 不压缩、不限数量（按需求）
- 单文件硬上限 **50MB**（`MAX_ATTACHMENT_BYTES`，仅作 OOM 防护）
- bytea 字段 PostgreSQL 自动 TOAST 行外存储，查询元数据列表不会把二进制读进内存
- 备份随数据库 dump 一起完成，无需额外运维

### 为什么选 bytea 而非另两种

- **本地磁盘**：当前 Dockerfile 是 `standalone` 构建，需额外挂 volume + 改 `outputFileTracingIncludes` + 多实例需共享存储，运维成本高，docker-compose 无对应 volume 槽位
- **对象存储**：需新增 S3 SDK + 多个环境变量 + 部署 MinIO 或配云凭证，对单机科研项目系统过重

### 退出策略（未来数据量真的爆炸时）

- 所有附件读写集中在 `recordAttachment.service.ts` 一个服务层
- 表结构是 `data Bytes` 单字段；换 S3 只需：① 加 `storageKey` 字段 ② 把 `data` 读取换成 S3 pull ③ 一次性脚本把 bytea 导出 S3 并清空 `data` 列
- API 路由和 UI 都不动

## 2. API 与服务层

### 关键设计：统一上传端点

两种上传时机复用同一个 API——记录必须先存在，再上传附件。

- **表单内附带**：表单先 JSON 提交业务字段 → 成功拿到 `recordId` → 前端循环发上传请求
- **独立抽屉补充**：用户打开附件抽屉 → 直接选文件上传
- 两条路最终都打向同一个 `POST /attachments` 端点

### 服务层 `src/server/services/recordAttachment.service.ts`

仿照 `receipt.service.ts` 结构，导出：

```ts
listAttachments(recordId, user)                                        → RecordAttachmentMeta[]
getAttachment(id, user)                                                → { meta, data: Buffer }
createAttachment(recordId, file: { name, type, size, buffer }, user)   → RecordAttachmentMeta
deleteAttachment(id, user)                                             → void
listForExport(projectId, { budgetYear?, subjectId? }, user)            → Array<{ record, attachment }>
```

`RecordAttachmentMeta` **不含 `data` 字段**，结构：`{ id, fileName, contentType, sizeBytes, uploadedBy, createdAt }`。

### 权限（复用现有 `requirePermission`，不新增 action）

| 操作                   | 权限           | 谁能做                              |
| ---------------------- | -------------- | ----------------------------------- |
| 上传 / 删除            | `record:edit`  | ADMIN 或项目 OWNER/HANDLER          |
| 列表 / 下载 / 批量导出 | `project:view` | ADMIN / USER（USER 全局只读可查阅） |

### 校验（服务层是唯一拦截点）

- 文件大小：`size > MAX_ATTACHMENT_BYTES`（50MB）→ `HTTPError(413)`
- 类型：MIME 白名单 + 扩展名白名单双校验（防伪造）
  - 图片：`image/jpeg | image/png | image/webp | image/gif`
  - PDF：`application/pdf`
  - Office：`.doc/.docx/.xls/.xlsx/.ppt/.pptx`（MIME 对应 msword / openxmlformats-*）
- 不在白名单 → `HTTPError(415)`

### 审计

上传/删除各写一条 `AuditLog`（动作 `record_attachment_upload` / `record_attachment_delete`，关联 `recordId`），与现有 `recordAudit` 模式一致。

### API 路由

全部挂在 `src/app/api/projects/[id]/records/[recordId]/attachments/` 下，沿用 `{ params }: { params: Promise<...> }` 异步签名：

```
POST   /api/projects/[id]/records/[recordId]/attachments         上传（multipart，单个文件）
GET    /api/projects/[id]/records/[recordId]/attachments         列表
DELETE /api/projects/[id]/records/[recordId]/attachments/[attId] 删除单个
GET    /api/projects/[id]/records/[recordId]/attachments/[attId] 下载单个（Content-Disposition: attachment）
```

**批量导出**（按项目/年度/科目打包 zip，用已有的 `jszip`）：

```
GET /api/projects/[id]/attachments/export?budgetYear=2026&subjectId=xxx
   → Content-Type: application/zip
   → Content-Disposition: attachment; filename="附件_<项目名>_<年度>.zip"
```

zip 内文件名：`<业务日期>_<摘要>_<原文件名>`，冲突时追加序号。

### 上传路由关键实现（对齐 `imports/route.ts`）

```ts
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: projectId, recordId } = await params;
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File))
      return NextResponse.json({ error: '缺少上传文件' }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const meta = await createAttachment(
      recordId,
      {
        name: file.name,
        type: file.type,
        size: file.size,
        buffer,
      },
      user,
    );
    return NextResponse.json(meta, { status: 201 });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
```

下载路由对齐 `src/app/api/excel-template/route.ts` 的 `downloadFile` 模式（`Content-Disposition: attachment; filename*=UTF-8''<encoded>`，处理中文文件名）。

### body 大小配置

App Router Node 运行时 multipart 默认约 4MB/字段。50MB 单文件需在实现时实测确认；若受限则采用 Next.js 16 的运行时配置或文档化实际可用上限。此为已识别风险（见 §5），不阻塞整体架构。

## 3. 前端 UI 与上传流程

### A. 嵌入业务创建/编辑对话框（表单内可选附带）

在 `src/app/(dashboard)/projects/[id]/records/page.tsx` 的 `recordSchema` 表单里，提交按钮上方新增「报销凭证」区块：

```
┌─ 新建/编辑业务 ──────────────────────┐
│  科目 *   [下拉]                      │
│  金额 *   [输入]                      │
│  业务日期 *、经办人、摘要、备注 ...   │
│                                      │
│  报销凭证  [选择文件] [选择文件]      │  ← 新增
│  ┌──────────────────────────────┐   │
│  │ 📄 发票_差旅.pdf  1.2MB ×    │   │  ← 待传清单
│  │ 🖼️ 收据.jpg       880KB ×    │   │
│  └──────────────────────────────┘   │
│                          [取消] [保存] │
└──────────────────────────────────────┘
```

- 编辑已有记录时：区块顶部显示「已有附件」列表（**只读**：仅展示文件名/大小/下载链接，不可在此删除——删除走 §3-B 附件抽屉），下方是「新增」文件选择——区分"已存的"和"待传的"
- **zod schema 不动**：附件是 `File[]`（前端临时态），不参与表单 JSON body
- **提交流程**（`submitForm` 改造）：
  1. 现有逻辑：JSON 提交业务字段 → 拿到 `recordId`（新建）或确认更新成功（编辑）
  2. 新增逻辑：遍历 `pendingFiles`，对每个文件调 `uploadAttachment(recordId, file)`
  3. 任何一个上传失败 → **业务已保存成功**，不回滚业务；提示「业务已保存，N 个附件上传失败，可在附件抽屉重试」
  4. 全部成功 → 关闭对话框，刷新列表

关键原则：**业务提交和附件上传解耦**——附件失败不丢业务数据。

### B. 独立附件抽屉（事后查看/补充/删除）

表格每行新增附件入口：左侧回形针徽标 + 数量角标（`📎 3`），无附件时灰色 `📎`。点击打开 shadcn `Sheet`（右侧抽屉）：

```
┌─ 报销凭证 · 差旅费报销 ──────────────┐
│                                       │
│  业务: 差旅费 - 张三  ¥1,200          │  ← 上下文头部
│  业务日期: 2026-08-05                 │
│                                       │
│  [+ 添加文件]    (拖拽到此处也可)      │
│                                       │
│  ───────────────────────────────────  │
│  📄 发票_差旅.pdf     1.2MB  下载 删除 │
│  🖼️ 收据.jpg          880KB  下载 删除 │
│  📊 明细.xlsx          45KB  下载 删除 │
│  ───────────────────────────────────  │
│                                       │
│  支持图片/PDF/Office，单文件 ≤50MB    │  ← 大小提示
└───────────────────────────────────────┘
```

抽屉特性：

- 拖拽上传（drag-and-drop dropzone）+ 点击选择
- 多选批量上传，逐个调上传 API，实时进度（`上传中 2/3...`）
- 列表实时刷新，失败项红色标注可重试
- 下载/删除权限按 `canWriteRecords` 控制按钮显隐（下载用 `project:view`，删除用 `record:edit`）
- 作废记录：附件可查看可下载，上传/删除按钮禁用（灰色 + tooltip「已作废记录不可修改附件」）

### C. 批量导出入口

附件入口放在记录页顶部工具栏（与现有「导入 Excel」「导出」按钮并列）：

```
[筛选栏: 年度 ▼  科目 ▼  状态 ▼]
[导入 Excel] [导出] [📦 导出附件(zip)]   ← 新增
└─ 表格 ──┘
```

- 点击沿用当前筛选条件（年度/科目/状态/日期范围）→ 调 `GET /attachments/export?budgetYear=&subjectId=`
- 浏览器原生下载 zip
- 无附件时后端返回 404 + 提示「所选范围内无附件」

### 客户端上传工具

新增 `src/lib/api/upload.ts`，**绕过 `apiFetch`**（`apiFetch` 强制 `Content-Type: application/json`），对齐 `imports/page.tsx` 的 `bootstrapMockUser()` 模式：

```ts
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
  if (!res.ok) throw new Error((await res.json().catch(() => ({})).error) ?? '上传失败');
  return res.json();
}
```

下载同理：`downloadAttachment(attId)` → blob 流式下载（大文件优先 blob）。

### 体积提示（按需求）

- 抽屉底部常驻文案：`支持图片 / PDF / Office 文档，单文件 ≤ 50MB`
- 选择文件后，待传清单每项显示大小（KB/MB 自动换算）
- 单文件超 50MB → 客户端直接拦截，不发请求，红色提示「文件过大，请压缩或拆分」

### 不做的事（YAGNI）

- 不做图片预览/缩略图（凭证查阅场景，点击下载即可；缩略图需引入 sharp 生成，违反"不压缩"意图）
- 不做 OCR / 发票识别（远超范围）
- 不做附件版本管理（简单删除+重传即可）

## 4. 实现切片

| #   | 切片           | 产出                                                                                                       | 可验证点                             |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | Prisma 迁移    | `schema.prisma` 加 `RecordAttachment` + 反向关系；`prisma migrate dev` 生成迁移                            | `prisma studio` 看到表；类型生成成功 |
| 2   | 服务层         | `recordAttachment.service.ts`：list/get/create/delete/listForExport + 校验 + 权限 + 审计                   | 单元测试通过                         |
| 3   | CRUD API 路由  | POST/GET-list/GET-download/DELETE 四个端点                                                                 | curl 全流程跑通                      |
| 4   | 环境配置       | `src/lib/env.ts` 加 `MAX_ATTACHMENT_BYTES`（默认 50MB）+ `ALLOWED_ATTACHMENT_TYPES`；`.env.example` 补注释 | env 启动校验通过                     |
| 5   | 客户端上传工具 | `src/lib/api/upload.ts`（上传/下载函数）                                                                   | —                                    |
| 6   | 独立附件抽屉   | 记录表格附件徽标 + Sheet 组件（拖拽上传、列表、下载、删除、进度、大小提示）                                | 浏览器手动验证全流程                 |
| 7   | 表单内附带     | `records/page.tsx` 的 Dialog 加「报销凭证」区块 + `submitForm` 改造（先存业务再传附件）                    | 创建/编辑带附件验证                  |
| 8   | 批量导出 API   | `GET /attachments/export`（jszip 打包，复用现有筛选）                                                      | curl 导出验证 zip 内容               |
| 9   | 批量导出 UI    | 记录页工具栏「导出附件」按钮 + 沿用筛选                                                                    | 浏览器下载验证                       |

切片 1-5 是地基，6-7 是两种上传时机的 UI，8-9 是导出能力。任一切片失败不影响已交付切片。

## 5. 测试策略

对齐项目现有 `vitest` 设置。

**单元测试（切片 2 服务层）** —— 仿照已有服务层测试：

- 类型/大小校验：超 50MB 抛 413、非白名单 MIME 抛 415、扩展名与 MIME 不符抛 415
- 权限：非项目成员 `record:edit` 抛 403；USER 全局只读能 list/get 但 create 抛 403
- 边界：作废记录上传抛 400（业务规则：作废记录不可加附件）
- `listForExport` 按年度/科目正确过滤

**集成测试（切片 3/8 路由层）**：

- 上传 → 列表 → 下载（校验下载 bytea 与上传一致）→ 删除 → 列表为空
- 导出端点：有附件返回 zip + 正确文件名；无附件返回 404

UI 层沿用项目现状（手动验证为主，不强制加组件测试，实现时先确认是否有先例）。

## 6. 迁移与向后兼容

- 新表 `record_attachments`，不改现有任何表结构 → 对存量数据零影响
- 不迁移历史业务记录（它们本就没附件）
- schema 变更只增不删，`prisma migrate dev` 生成纯 `CREATE TABLE` 迁移，可安全在生产 `migrate deploy`
- 现有 `BusinessRecord` 的 TypeScript 类型通过 `prisma generate` 自动获得 `attachments` 关系字段，不影响现有消费代码

## 7. 风险评估

| 风险                                       | 概率 | 影响               | 缓解                                                                                                 |
| ------------------------------------------ | ---- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| Next.js 16 body 大小限制导致 50MB 上传被拒 | 中   | 单文件无法上传     | 切片 3 优先实测；若受限则文档化实际可用上限，UI 提示据此调整                                         |
| 数据库体积随附件增长（年增 GB 级）         | 低   | 备份变大、查询略慢 | TOAST 自动行外存储；监控表大小；预留 bytea→S3 退出路径（§1）                                         |
| 大文件下载阻塞 Node 事件循环               | 低   | 接口变慢           | 下载用 `Response` 流式返回 Buffer；超大批量导出限制单次最大附件数（如 500 个，超出提示分批）         |
| 作废记录附件被误删                         | 低   | 凭证丢失           | 作废流程不动附件；删除附件单独权限审计；`onDelete: Cascade` 仅在物理删记录时触发（当前系统不物理删） |
| 中文文件名下载乱码                         | 低   | 体验问题           | 用 RFC 5987 `filename*=UTF-8''<encoded>`，对齐 `excel-template` 路由已有实现                         |

## 8. 文档更新

实现完成后：

- `CHANGELOG.md`：新增一节 `## [X.Y.Z]` 记录此功能（`feat`，按 AGENTS.md 走 `npm version minor`）
- `.env.example`：补 `MAX_ATTACHMENT_BYTES` / `ALLOWED_ATTACHMENT_TYPES` 注释
- 不动 `AGENTS.md`（权限模型复用现有 action，无新约定）

## 涉及文件清单

**新增**：

- `prisma/migrations/<timestamp>_record_attachments/migration.sql`（prisma 生成）
- `src/server/services/recordAttachment.service.ts`
- `src/app/api/projects/[id]/records/[recordId]/attachments/route.ts`（POST + GET list）
- `src/app/api/projects/[id]/records/[recordId]/attachments/[attId]/route.ts`（GET download + DELETE）
- `src/app/api/projects/[id]/attachments/export/route.ts`（GET 批量导出）
- `src/lib/api/upload.ts`（客户端上传/下载工具）
- `src/components/records/AttachmentSheet.tsx`（附件抽屉组件）
- 测试文件若干（`*.test.ts`）

**修改**：

- `prisma/schema.prisma`（新增模型 + 反向关系）
- `src/lib/env.ts`（新增上传相关环境变量）
- `.env.example`（注释新增变量）
- `src/app/(dashboard)/projects/[id]/records/page.tsx`（表单附件区块 + 附件徽标列 + 工具栏导出按钮 + `submitForm` 改造）
- `CHANGELOG.md`（发布时）
