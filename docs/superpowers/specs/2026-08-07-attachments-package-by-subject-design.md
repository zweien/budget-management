# 按预算科目层级打包附件 — 设计文档

- **日期**: 2026-08-07
- **状态**: 已确认设计，待实现
- **目标**: 将项目全部科目的报销凭证附件，按预算目录的层级整理成文件夹，文件名可自定义，打包 zip 下载，便于整理经费报告
- **依赖**: 业务记录报销凭证附件功能（PR #6，已合并到 main）

## 决策摘要

| 维度                          | 选择                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| 与现有「导出附件(zip)」的关系 | **新增独立入口**，保留现有扁平导出不动                                      |
| 范围                          | 项目**全部年度、全部科目**的附件；年度可选筛选（默认全部）                  |
| 文件夹路径                    | 根→叶科目 walk `parentId`，每层 = `${code}_${name}`                         |
| 文件名模板                    | UI 占位符输入框 + 默认 `{date}_{amount}_{summary}_{original}`，前端实时预览 |
| 权限                          | 复用 `project:view`（与现有导出一致）                                       |
| 内存防护                      | 复用 heap-guard（count 前置 → 上限 → 才加载 bytea）                         |

## 1. 功能定位

现有「导出附件(zip)」（记录页工具栏）是**扁平**的、按当前视图筛选（单年度/单科目）的快速导出。本功能面向"**整理经费报告**"场景：把项目所有凭证按预算科目目录结构整理成层级文件夹，文件名按规则命名，一次打包。

两个入口并存、互不影响：

- 现有按钮：`导出附件(zip)`（扁平 + 筛选）—— 不动
- 新按钮：`整理报告 · 按科目打包`（层级文件夹 + 可定制文件名 + 全项目范围）

## 2. 文件夹结构

### 路径构建

预算科目是邻接表（`parentId` 自关联），`code` 是扁平助记符（如 `ZJF`、`SBF`），**不是路径字符串**。文件夹路径必须 walk `parentId` 到根来构建：

1. 一次性加载项目全部 `BudgetSubject`（按 `sortOrder, code` 排序），建 `subjectById: Map`
2. 对每个附件的 `record.subjectId`，从叶向上 walk `parentId` 到根，收集链，反转
3. 每层文件夹段 = `${subject.code}_${subject.name}`，消毒后用 `/` 连接

### 文件夹段消毒

复用现有 regex `[\\/:*?"<>|\0]` → `_`，额外处理：

- 去除前导/尾随空格和点（防 Windows 隐藏/保留问题）
- 命中 Windows 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`，大小写不敏感）→ 追加 `_`

### 示例

科目树：

```
ZJF 直接费
└─ SBF 设备费
   └─ SBGZF 设备购置费 (叶)
```

业务记录挂在 `SBGZF`，附件 `发票.pdf`，模板 `{date}_{amount}_{handler}_{original}`：

```
ZJF_直接费/SBF_设备费/SBGZF_设备购置费/2026-08-05_1200.00_张三_发票.pdf
```

### 叶科目的必然性

业务记录**只挂叶科目**（`requireLeafSubject` 强制，`businessRecord.service.ts`）。所以附件永远落在叶文件夹下；非叶文件夹只作为路径中间段，**永远不会有文件直接位于非叶文件夹**。

## 3. 文件名模板

### 占位符

UI 提供模板输入框，用户用占位符组合。可用字段映射到 `BusinessRecord`：

| 占位符       | 含义                   | 取值示例     | 数据来源                                     |
| ------------ | ---------------------- | ------------ | -------------------------------------------- |
| `{date}`     | 业务日期               | `2026-08-05` | `businessDate` → `toISOString().slice(0,10)` |
| `{amount}`   | 金额（2位小数）        | `1200.00`    | `amount.toFixed(2)`                          |
| `{handler}`  | 经办人                 | `张三`       | `handler`                                    |
| `{subject}`  | 叶科目名称             | `设备购置费` | `subject.name`（叶节点）                     |
| `{summary}`  | 摘要（截断40字）       | `差旅费`     | `summary.slice(0,40)`                        |
| `{status}`   | 业务状态               | `PAID`       | `status` 枚举字符串                          |
| `{year}`     | 预算年度               | `2026`       | `budgetYear`                                 |
| `{original}` | 原始文件名（含扩展名） | `发票.pdf`   | `attachment.fileName`                        |

**默认模板**：`{date}_{amount}_{summary}_{original}`

### 模板校验（服务端 + 客户端双校验）

- 未知占位符（如 `{foo}`）→ **原样保留**（不报错，便于用户自由组合文本，如 `{date}_报销_{original}` 里的 `_报销_` 是字面量）
- 文件名消毒（同文件夹段）：替换非法字符、处理 Windows 保留名
- 空模板 → 用默认模板兜底
- 长度：单个文件名（含扩展名）超 200 字符 → 截断保留扩展名

### 实时预览

UI 在输入框下方用样例数据实时渲染预览：

```
预览: ZJF_直接费/SBF_设备费/SBGZF_设备购置费/2026-08-05_1200.00_差旅费_发票.pdf
```

样例数据用项目真实的第一条业务记录（若有附件）或硬编码示例。

## 4. 服务端实现

### 扩展 `listForExport`

当前 `record` select 只有 `{ id, businessDate, summary, handler }`，需补 `subjectId, amount, budgetYear, status` 以支持文件夹路径和文件名模板。

`listForExport` 返回类型扩展为：

```ts
Array<{
  record: {
    id: string;
    businessDate: Date;
    summary: string;
    handler: string;
    subjectId: string;
    amount: Decimal; // 或 Prisma.Decimal
    budgetYear: number;
    status: string; // BusinessStatus 枚举字符串
  };
  attachment: AttachmentMeta;
  data: Buffer;
}>;
```

`countForExport` / `buildExportWhere` 不变（它们不依赖这些字段）。

### 新增独立路由

```
GET /api/projects/[id]/attachments/package
  ?year=2026            (可选,默认全部年度)
  &template={date}_{amount}_{summary}_{original}   (可选,默认模板)
```

**职责**（对齐现有 export route 的模式）：

1. `requireUser()` + `await params` 取 `projectId`
2. 解析 `year`（Number，可选）、`template`（字符串，可选，默认模板兜底）
3. **heap-guard**：`countForExport(projectId, { budgetYear: year })` → `> 500` 返回 413「打包附件过多(上限 500 个),请按年度缩小范围」；`=== 0` 返回 404「无附件」
4. 加载项目全部 `BudgetSubject`（select `id, code, name, parentId`，按 `sortOrder, code` 排序），建 `subjectById` Map
5. `listForExport(projectId, { budgetYear: year }, user)` 取附件（已通过 count 上限，安全加载 bytea）
6. 对每个附件：walk `parentId` 构建文件夹路径 + 应用模板生成文件名（含消毒、去重）
7. JSZip 打包（`zip.folder(path).file(name, data)`），`generateAsync({ type: 'nodebuffer' })`
8. 返回 `application/zip` + `Content-Disposition: attachment; filename="attachments.zip"; filename*=UTF-8''<项目名>[_年度].zip`

### 文件名/路径去重

同一文件夹下文件名冲突时，在扩展名前追加 `(1)/(2)`（复用现有 export route 的去重 Map 逻辑）。

## 5. 前端实现

### 入口

记录页工具栏，现有「导出附件(zip)」按钮旁新增「整理报告 · 按科目打包」按钮（`FolderArchive` 图标）。点击打开一个配置 Dialog（不是直接下载，因为要选模板）。

### 配置 Dialog

```
┌─ 按科目打包附件 ────────────────────────┐
│                                          │
│  年度  [全部 ▼]   (可选 2024/2025/2026)  │
│                                          │
│  文件名模板                              │
│  ┌────────────────────────────────────┐ │
│  │ {date}_{amount}_{summary}_{original}│ │
│  └────────────────────────────────────┘ │
│  可用占位符(点击插入):                   │
│  {date} {amount} {handler} {subject}     │
│  {summary} {status} {year} {original}    │
│                                          │
│  预览:                                   │
│  ZJF_直接费/SBF_设备费/.../              │
│  2026-08-05_1200.00_差旅费_发票.pdf      │
│                                          │
│                          [取消] [打包下载]│
└──────────────────────────────────────────┘
```

- 年度下拉：从项目实际年度动态获取（复用记录页的 yearOptions 逻辑），默认"全部"
- 模板输入框：默认填入默认模板，占位符标签可点击插入光标处
- 预览：用样例数据实时渲染（template 变化即更新）
- **不提供"扁平/层级"切换**——本功能就是层级打包，切换会让职责模糊；扁平快速导出走现有「导出附件(zip)」入口

### 客户端工具

`src/lib/api/attachments.ts` 新增：

```ts
export function packageAttachmentsBySubject(
  projectId: string,
  query: { year?: number; template?: string },
): Promise<void>;
```

复用 `downloadFile`（blob 流式 + Content-Disposition 文件名）。

## 6. 权限与安全

- **权限**：`project:view`（含全局只读 USER），与现有 export 一致——整理报告是查阅场景
- **路径遍历防护**：文件夹段和文件名都消毒 `[\\/:*?"<>|\0]`，walk parentId 不会产生 `..`（数据库里 parentId 是真实 UUID），双重保险
- **zip-slip**：JSZip 的 `zip.folder().file()` 用我们构建的相对路径，不接触绝对路径；消毒已剥离 `/` `\`，无逃逸可能
- **模板注入**：模板是文件名字符串，占位符只做字符串替换，不执行任何代码；未知占位符原样保留

## 7. 不做的事（YAGNI）

- 不提供"取消层级"选项（退化为现有扁平导出，重复）
- 不支持自定义文件夹段格式（固定 `code_name`，简单稳定；模板只管文件名）
- 不做单科目筛选（既然是按全部科目层级整理，单科目场景用现有扁平导出）
- 不做流式 zip（`archiver`）——500 上限 + JSZip 足够；真到瓶颈再换

## 8. 涉及文件

**新增**：

- `src/app/api/projects/[id]/attachments/package/route.ts`（打包路由）
- 测试：`tests/api/attachments.package.test.ts`（路由集成测试，含文件夹结构、模板渲染、去重、消毒）

**修改**：

- `src/server/services/recordAttachment.service.ts`（`listForExport` 的 record select 补字段 + 返回类型）
- `src/lib/api/attachments.ts`（新增 `packageAttachmentsBySubject`）
- `src/app/(dashboard)/projects/[id]/records/page.tsx`（工具栏新增按钮 + 配置 Dialog）

## 9. 测试策略

对齐现有集成测试（真实 PG，串行）：

**路由测试**（`tests/api/attachments.package.test.ts`）：

- 多科目附件 → zip 内文件夹结构正确（walk parentId 链）
- 模板渲染：各占位符正确替换（`{amount}` 2位小数、`{date}` yyyy-mm-dd、`{status}` 枚举字符串）
- 未知占位符原样保留
- 文件名冲突去重（同文件夹下两个同名 → `(1)`）
- 文件夹段消毒（科目名含 `/` → `_`）
- 年度筛选：year=2026 只含该年度；year 不传含全部
- 超上限（>500）→ 413；无附件 → 404
- Content-Disposition 双段（ASCII fallback + UTF-8）

**服务层**：`listForExport` 返回类型扩展后，现有 service 测试需更新（多出的字段不破坏断言）。

## 10. 风险

| 风险                                          | 概率 | 影响               | 缓解                                                                      |
| --------------------------------------------- | ---- | ------------------ | ------------------------------------------------------------------------- |
| 科目树很深（>10层）→ 文件夹路径过长超 OS 限制 | 低   | 部分解压工具报错   | 文件夹段消毒 + 真实场景科研项目科目层级通常 ≤5 层；如真超长，截断保留叶层 |
| 500 上限对"全项目打包"不够                    | 中   | 大项目无法一次打包 | UI 在年度下拉默认选最近一年；413 提示按年度缩小范围；未来可考虑流式       |
| `amount` Decimal 序列化精度                   | 低   | 金额显示错         | 用 `toFixed(2)`（已有 decimal.js 封装），不用 `toString()`                |
| 模板含大量字面文本 → 文件名超长               | 低   | 解压工具截断       | 文件名 >200 字符截断保留扩展名                                            |
