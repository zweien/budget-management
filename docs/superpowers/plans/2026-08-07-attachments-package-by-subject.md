# 按预算科目层级打包附件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目全部科目的报销凭证附件，按预算目录的层级整理成文件夹、文件名按可定制模板命名，打包 zip 下载（整理经费报告专用入口）。

**Architecture:** 新增独立打包路由 `GET /api/projects/[id]/attachments/package`：先 count 前置防 OOM，加载附件时 walk 附件所属叶科目的 `parentId` 到根构建文件夹路径（每段 `${code}_${name}`），应用占位符模板生成文件名，JSZip 按层级打包。前端在记录页工具栏新增「按科目打包」按钮，点击弹配置 Dialog（年度 + 模板 + 实时预览）。现有扁平「导出附件(zip)」入口不动。

**Tech Stack:** Next.js 16 (App Router, Node runtime) · React 19 · Prisma 5 · PostgreSQL · shadcn/ui · JSZip · vitest（集成测试，真实 PG `:5434`，串行）

## Global Constraints

- **测试是集成测试**，直连真实 PG `localhost:5434`，`vitest.config.ts` 配 `pool: 'forks'` + `singleFork: true`。每个测试自建项目+科目+记录+附件并清理。复用 `tests/api/attachments.route.test.ts` 的 `seedApprovedProject` 夹具模式（`createDraft → submitDraft → approveApplication` 落库叶科目，因为 `createProject` 不建科目）。
- **API 路由签名**：Next.js 16 异步 params —— `{ params }: { params: Promise<{ id: string }> }`，体内 `const { id } = await params`。query 用 `(req.nextUrl ?? new URL(req.url)).searchParams`（兼容裸 Request 测试）。
- **权限**：复用 `requirePermission(user, 'project:view', projectId)`（含全局只读 USER），与现有 export route 一致。
- **内存防护**：复用 `countForExport`（不加载 bytea）→ `> 500` 返回 413 → 才调 `listForExport` 加载 bytea。`EXPORT_MAX_ATTACHMENTS = 500`。
- **消毒**：文件夹段和文件名都替换 `[\\/:*?"<>|\0]` → `_`；文件夹段额外处理 Windows 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`，大小写不敏感 → 追加 `_`）和前导/尾随空格点。
- **业务记录只挂叶科目**（`requireLeafSubject` 强制），所以附件永远落在叶文件夹；非叶文件夹只作路径中间段。
- **walk parentId 模式**：参照 `adjustmentExport.service.ts:91-103` 的 `findSecondLevelTitle`，用 `subjectById: Map` 上溯。
- **下载**复用 `downloadFile`（`src/lib/api/client.ts`），blob 流式 + Content-Disposition 双段（ASCII fallback `attachments.zip` + `filename*=UTF-8''<编码>`）。
- **Decimal 金额**：用 `.toFixed(2)`（Prisma Decimal 支持），不用 `toString()`（丢尾零）。
- **错误**抛 `HTTPError(status, message)`，路由 catch 转 `{ error }` JSON。

## File Structure

**新增**：

| 文件                                                     | 职责                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/lib/attachments/packagePath.ts`                     | 纯函数：文件夹段消毒、路径构建（walk parentId）、模板渲染、文件名生成。无 IO/无 DB，便于单测 |
| `src/app/api/projects/[id]/attachments/package/route.ts` | 打包路由：count 前置 → 加载科目树 + 附件 → 调 packagePath 构建 → JSZip 打包                  |
| `src/components/records/PackageAttachmentsDialog.tsx`    | 配置 Dialog（年度下拉 + 模板输入 + 占位符快插 + 实时预览）                                   |
| `tests/lib/attachments/packagePath.test.ts`              | packagePath 纯函数单测                                                                       |
| `tests/api/attachments.package.test.ts`                  | 打包路由集成测试                                                                             |

**修改**：

| 文件                                                 | 改动                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/server/services/recordAttachment.service.ts`    | `listForExport` 的 `record` select 补 `subjectId, amount, budgetYear, status`；返回类型扩展 |
| `src/lib/api/attachments.ts`                         | 新增 `packageAttachmentsBySubject(projectId, { year?, template? })`                         |
| `src/app/(dashboard)/projects/[id]/records/page.tsx` | 工具栏新增「按科目打包」按钮 + 挂载 PackageAttachmentsDialog                                |

**职责边界**：`packagePath.ts` 纯函数（路径/文件名构建，可单测），路由只编排（DB + 打包），`PackageAttachmentsDialog` 纯 UI，客户端 `attachments.ts` 只 fetch 封装。

---

## Task 1: 路径与文件名构建纯函数

**Files:**

- Create: `src/lib/attachments/packagePath.ts`
- Test: `tests/lib/attachments/packagePath.test.ts`

**Interfaces:**

- Consumes: 无（纯函数，输入是普通对象）
- Produces:
  - `interface SubjectNode { id: string; code: string; name: string; parentId: string | null; level: number; isLeaf: boolean }`
  - `sanitizeSegment(s: string): string` —— 文件夹/文件名段消毒（非法字符→`_`、Windows 保留名处理、去首尾空格点）
  - `buildFolderPath(subjectId: string, subjectById: Map<string, SubjectNode>): string` —— walk parentId 到根，每段 `${code}_${name}` 消毒后 `/` 连接
  - `TOKENS: Record<string, (ctx: TokenContext) => string>` —— 占位符→取值函数映射
  - `interface TokenContext { date: string; amount: string; handler: string; subject: string; summary: string; status: string; year: string; original: string }`
  - `renderFilename(template: string, ctx: TokenContext): string` —— 模板渲染（未知占位符原样保留）+ 消毒 + 长度截断（>200 保留扩展名）
  - `dedupeName(name: string, used: Map<string, number>): string` —— 冲突追加 `(n)` 并更新计数

- [ ] **Step 1: 写失败测试 — packagePath 纯函数**

创建 `tests/lib/attachments/packagePath.test.ts`：

```ts
import { describe, it, expect } from 'vitest';

import {
  sanitizeSegment,
  buildFolderPath,
  renderFilename,
  dedupeName,
  type SubjectNode,
  type TokenContext,
} from '@/lib/attachments/packagePath';

// 测试用科目树:根 → 二级 → 叶
const subjects: SubjectNode[] = [
  { id: 'root', code: 'ZJF', name: '直接费', parentId: null, level: 1, isLeaf: false },
  { id: 'l2', code: 'SBF', name: '设备费', parentId: 'root', level: 2, isLeaf: false },
  { id: 'leaf', code: 'SBGZF', name: '设备购置费', parentId: 'l2', level: 3, isLeaf: true },
];
const subjectById = new Map(subjects.map((s) => [s.id, s]));

const ctx: TokenContext = {
  date: '2026-08-05',
  amount: '1200.00',
  handler: '张三',
  subject: '设备购置费',
  summary: '差旅费',
  status: 'PAID',
  year: '2026',
  original: '发票.pdf',
};

describe('sanitizeSegment', () => {
  it('替换路径分隔符与 Windows 非法字符', () => {
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });
  it('NUL 字节替换', () => {
    expect(sanitizeSegment('a\0b')).toBe('a_b');
  });
  it('Windows 保留名追加下划线', () => {
    expect(sanitizeSegment('CON')).toBe('CON_');
    expect(sanitizeSegment('nul')).toBe('nul_');
    expect(sanitizeSegment('COM1')).toBe('COM1_');
    expect(sanitizeSegment('lpt9')).toBe('lpt9_');
  });
  it('普通名保留;去首尾空格与点', () => {
    expect(sanitizeSegment('  正常名称  ')).toBe('正常名称');
    expect(sanitizeSegment('.隐藏.')).toBe('隐藏');
  });
});

describe('buildFolderPath', () => {
  it('从叶到根 walk parentId,每段 code_name', () => {
    expect(buildFolderPath('leaf', subjectById)).toBe('ZJF_直接费/SBF_设备费/SBGZF_设备购置费');
  });
  it('根节点(无 parentId)只返回自身段', () => {
    expect(buildFolderPath('root', subjectById)).toBe('ZJF_直接费');
  });
  it('科目名含非法字符时消毒', () => {
    const subs: SubjectNode[] = [
      { id: 'r', code: 'X', name: 'a/b', parentId: null, level: 1, isLeaf: false },
      { id: 'l', code: 'Y', name: '叶', parentId: 'r', level: 2, isLeaf: true },
    ];
    expect(buildFolderPath('l', new Map(subs.map((s) => [s.id, s])))).toBe('X_a_b/Y_叶');
  });
  it('subjectId 不在 map 中 → 空字符串(防御)', () => {
    expect(buildFolderPath('unknown', subjectById)).toBe('');
  });
});

describe('renderFilename', () => {
  it('默认模板渲染各占位符', () => {
    expect(renderFilename('{date}_{amount}_{summary}_{original}', ctx)).toBe(
      '2026-08-05_1200.00_差旅费_发票.pdf',
    );
  });
  it('未知占位符原样保留(字面量)', () => {
    expect(renderFilename('{date}_报销_{original}', ctx)).toBe('2026-08-05_报销_发票.pdf');
  });
  it('所有占位符:handler/subject/status/year', () => {
    expect(renderFilename('{handler}_{subject}_{status}_{year}', ctx)).toBe(
      '张三_设备购置费_PAID_2026',
    );
  });
  it('渲染后消毒非法字符', () => {
    const c: TokenContext = { ...ctx, summary: 'a/b' };
    expect(renderFilename('{summary}_{original}', c)).toBe('a_b_发票.pdf');
  });
  it('超长文件名(>200)截断保留扩展名', () => {
    const long = 'X'.repeat(300);
    const c: TokenContext = { ...ctx, summary: long };
    const out = renderFilename('{summary}_{original}', c);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.pdf')).toBe(true);
  });
  it('空模板 → 返回 original(兜底)', () => {
    expect(renderFilename('', ctx)).toBe('发票.pdf');
  });
});

describe('dedupeName', () => {
  it('首次不追加', () => {
    const used = new Map<string, number>();
    expect(dedupeName('a.pdf', used)).toBe('a.pdf');
    expect(used.get('a.pdf')).toBe(1);
  });
  it('冲突追加 (1)/(2) 在扩展名前', () => {
    const used = new Map<string, number>([['a.pdf', 1]]);
    expect(dedupeName('a.pdf', used)).toBe('a(1).pdf');
    expect(used.get('a.pdf')).toBe(2);
    expect(dedupeName('a.pdf', used)).toBe('a(2).pdf');
  });
  it('无扩展名时追加在末尾', () => {
    const used = new Map<string, number>([['noext', 1]]);
    expect(dedupeName('noext', used)).toBe('noext(1)');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/lib/attachments/packagePath.test.ts`
Expected: FAIL（`Cannot find module '@/lib/attachments/packagePath'`）

- [ ] **Step 3: 实现 packagePath.ts**

创建 `src/lib/attachments/packagePath.ts`：

```ts
/**
 * 按预算科目层级打包附件 — 路径与文件名构建(纯函数,无 IO/无 DB)。
 *
 * 文件夹路径:walk 附件所属叶科目的 parentId 到根,每段 `${code}_${name}`。
 * 文件名:占位符模板渲染({date}/{amount}/.../{original})。
 * 全部经过 OS 安全消毒(防 zip-slip 与 Windows 非法字符)。
 */

export interface SubjectNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  level: number;
  isLeaf: boolean;
}

export interface TokenContext {
  date: string; // yyyy-mm-dd
  amount: string; // 2 位小数
  handler: string;
  subject: string; // 叶科目名
  summary: string;
  status: string; // 枚举字符串
  year: string;
  original: string; // 原文件名(含扩展名)
}

const ILLEGAL_CHARS = /[\\/:*?"<>|\0]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 200;

/** 单段(文件夹名/文件名)消毒:替换非法字符 + Windows 保留名 + 去首尾空格点。 */
export function sanitizeSegment(s: string): string {
  let out = s
    .replace(ILLEGAL_CHARS, '_')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (WINDOWS_RESERVED.test(out)) out += '_';
  return out;
}

/**
 * 构建根→叶的文件夹路径,每段 `${code}_${name}` 消毒后用 `/` 连接。
 * subjectId 不在 map → 空串(调用方应保证存在,此处防御)。
 */
export function buildFolderPath(subjectId: string, subjectById: Map<string, SubjectNode>): string {
  const chain: SubjectNode[] = [];
  let cur = subjectById.get(subjectId);
  if (!cur) return '';
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? subjectById.get(cur.parentId) : undefined;
  }
  return chain.map((s) => sanitizeSegment(`${s.code}_${s.name}`)).join('/');
}

/** 占位符 → 取值函数。 */
const TOKENS: Record<string, (ctx: TokenContext) => string> = {
  date: (c) => c.date,
  amount: (c) => c.amount,
  handler: (c) => c.handler,
  subject: (c) => c.subject,
  summary: (c) => c.summary,
  status: (c) => c.status,
  year: (c) => c.year,
  original: (c) => c.original,
};

/**
 * 渲染文件名:把 {token} 替换为对应值,未知占位符原样保留。
 * 渲染后整体消毒;空模板 → 用 original 兜底;超长(>200)截断保留扩展名。
 */
export function renderFilename(template: string, ctx: TokenContext): string {
  const tpl = template.trim() || '{original}';
  let out = tpl.replace(/\{(\w+)\}/g, (full, key: string) => {
    const fn = TOKENS[key];
    return fn ? fn(ctx) : full;
  });
  out = sanitizeSegment(out);
  if (out.length > MAX_NAME) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 10 ? out.slice(dot) : '';
    out = out.slice(0, MAX_NAME - ext.length) + ext;
  }
  return out;
}

/**
 * 同一文件夹下文件名去重:冲突时在扩展名前追加 (1)/(2)…,并更新 used 计数。
 */
export function dedupeName(name: string, used: Map<string, number>): string {
  const count = used.get(name) ?? 0;
  used.set(name, count + 1);
  if (count === 0) return name;
  const dot = name.lastIndexOf('.');
  const deduped =
    dot > 0 ? `${name.slice(0, dot)}(${count})${name.slice(dot)}` : `${name}(${count})`;
  // 去重后的名字本身也要登记(避免 (1) 与原 (1) 再次撞)
  used.set(deduped, (used.get(deduped) ?? 0) + 1);
  return deduped;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/lib/attachments/packagePath.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/attachments/packagePath.ts tests/lib/attachments/packagePath.test.ts
git commit -m "feat(attachments): 按科目层级打包的路径/文件名构建纯函数"
```

---

## Task 2: 扩展 listForExport 返回字段

**Files:**

- Modify: `src/server/services/recordAttachment.service.ts`（`listForExport` 的 select 与返回类型，约 line 233-262）
- Test: 复用 `tests/server/recordAttachment.service.test.ts`（更新现有 listForExport 断言）

**Interfaces:**

- Consumes: 无新依赖
- Produces: `listForExport` 返回的 `record` 对象新增 `subjectId: string, amount: Decimal, budgetYear: number, status: string`。Task 3 的打包路由依赖这些字段构建文件夹路径和文件名。

> 说明：本任务只扩展服务层查询字段，不改过滤口径（`buildExportWhere`/`countForExport` 不动）。现有 export 路由（扁平 zip）消费这些字段不受影响——它只取 `businessDate/summary/handler`，多出的字段忽略。

- [ ] **Step 1: 更新现有 listForExport 测试断言（验证新字段）**

在 `tests/server/recordAttachment.service.test.ts` 的 `listForExport` 测试用例里（搜 `listForExport` 找到那个 `it(...)`），在现有断言 `expect(hit!.record.summary)` 之后追加对新字段的断言：

```ts
// Task 2:返回类型扩展,新增 subjectId/amount/budgetYear/status 字段
expect(hit!.record.subjectId).toBe(record.subjectId);
expect(hit!.record.amount.toFixed(2)).toBe('100.00');
expect(hit!.record.budgetYear).toBe(2026);
expect(hit!.record.status).toBe('PLACEHOLDER');
```

> 实现时先 `git grep -n "listForExport" tests/server/recordAttachment.service.test.ts` 定位该用例，在 `expect(hit).toBeTruthy();` 之后的断言区追加。若用例里没有 `record.subjectId` 等上下文变量，从 `seedRecord` 返回的 `record` 取（夹具返回 `{ project, record }`，`record` 有 subjectId/budgetYear/status；amount 来自 createRecord 入参）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/server/recordAttachment.service.test.ts`
Expected: FAIL（`hit.record.subjectId` 是 undefined，因为 select 没取）。

- [ ] **Step 3: 修改 listForExport 的 select 与返回类型**

在 `src/server/services/recordAttachment.service.ts` 的 `listForExport`：

返回类型（line ~237-243）改为：

```ts
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
```

`findMany` 的 `record` select（line ~248）改为：

```ts
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
```

`map` 返回（line ~253-261）的 `record` 直接透传，无需改（`const { record, data, uploadedBy, ...meta } = r;` 已包含扩展后的 record）。

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
npx vitest run tests/server/recordAttachment.service.test.ts
npx vitest run tests/api/attachments.route.test.ts
```

Expected: service 测试 PASS（新断言通过）；route 测试仍 PASS（扁平 export 不受影响，多出的字段忽略）。

- [ ] **Step 5: 类型检查**

Run: `npm run check-types`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/server/services/recordAttachment.service.ts tests/server/recordAttachment.service.test.ts
git commit -m "feat(attachments): listForExport 返回补 subjectId/amount/budgetYear/status(供按科目打包)"
```

---

## Task 3: 打包 API 路由

**Files:**

- Create: `src/app/api/projects/[id]/attachments/package/route.ts`
- Create: `tests/api/attachments.package.test.ts`

**Interfaces:**

- Consumes:
  - `countForExport(projectId, { budgetYear }, user)` / `listForExport(projectId, { budgetYear }, user)`（Task 2 后 listForExport 返回含 subjectId/amount/budgetYear/status）
  - `buildFolderPath` / `renderFilename` / `dedupeName`（Task 1）
  - `prisma.budgetSubject.findMany`（加载科目树）、`prisma.project.findUnique`（取项目名）
  - `requireUser` / `HTTPError`
- Produces: `GET /api/projects/[id]/attachments/package?year=&template=` → 200 `application/zip`（含层级文件夹）；>500 → 413；无附件 → 404。

- [ ] **Step 1: 写失败测试 — 打包路由集成测试**

创建 `tests/api/attachments.package.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { UserRole } from '@prisma/client';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { createRecord } from '@/server/services/businessRecord.service';
import {
  createDraft,
  submitDraft,
  approveApplication,
} from '@/server/services/initialBudget.service';
import { GET } from '@/app/api/projects/[id]/attachments/package/route';

// mock 鉴权:requireUser 返回 admin。
let MOCK_ADMIN_ID: string;
vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/session')>)();
  return {
    ...actual,
    requireUser: async () => ({ id: MOCK_ADMIN_ID, role: UserRole.ADMIN, name: 'admin' }) as never,
  };
});

async function seedApprovedProject(adminId: string) {
  const project = await createProject(
    { code: `PK-${uuidv7().slice(0, 8)}`, name: `package ${uuidv7().slice(0, 4)}` },
    { id: adminId, role: UserRole.ADMIN },
  );
  // createProject 不建科目 → 走 createDraft→submit→approve 落库叶科目(对齐 businessRecord.service.test.ts)。
  const draft = await createDraft(
    project.id,
    {
      year: 2026,
      initialAmount: '100000.00',
      lines: [
        { code: 'ROOT', name: '根科目', parentCode: null, isLeaf: false, amount: '100000.00' },
        { code: 'LEAF', name: '叶科目', parentCode: 'ROOT', isLeaf: true, amount: '100000.00' },
      ],
    },
    { id: adminId, role: UserRole.ADMIN },
  );
  const appId = await submitDraft(draft.id, { id: adminId, role: UserRole.ADMIN });
  await approveApplication(appId, { id: adminId, role: UserRole.ADMIN });
  return project;
}

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.recordAttachment.deleteMany({ where: { record: { projectId } } }).catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('attachments package route (按科目层级打包)', () => {
  const createdProjectIds: string[] = [];
  let projectId: string;
  let leafSubjectId: string;
  let recordId: string;

  beforeAll(async () => {
    await prisma.$connect();
    MOCK_ADMIN_ID = uuidv7();
    await prisma.user.create({
      data: { id: MOCK_ADMIN_ID, name: 'admin-pkg', role: UserRole.ADMIN },
    });
    const project = await seedApprovedProject(MOCK_ADMIN_ID);
    createdProjectIds.push(project.id);
    projectId = project.id;
    leafSubjectId = await prisma.budgetSubject
      .findFirst({ where: { projectId, isLeaf: true }, select: { id: true } })
      .then((s) => s!.id);
    // 建一条业务记录(挂在叶科目)。
    const { record } = await createRecord(
      projectId,
      {
        budgetYear: 2026,
        subjectId: leafSubjectId,
        amount: '1200.00',
        businessDate: '2026-08-05',
        handler: '张三',
        summary: '差旅费',
        status: 'PAID',
      },
      { id: MOCK_ADMIN_ID, role: UserRole.ADMIN },
    );
    recordId = record.id;
    // 上传一个附件(直接写库,跳过 multipart)。
    await prisma.recordAttachment.create({
      data: {
        id: uuidv7(),
        recordId,
        fileName: '发票.pdf',
        contentType: 'application/pdf',
        sizeBytes: 41,
        data: Buffer.from('%PDF-1.4 test'),
        uploadedById: MOCK_ADMIN_ID,
      },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    await prisma.user.deleteMany({ where: { id: MOCK_ADMIN_ID } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function callPackage(query: string) {
    const url = `http://localhost/api/projects/${projectId}/attachments/package${query}`;
    const req = new Request(url);
    const res = await GET(req as never, { params: Promise.resolve({ id: projectId }) } as never);
    return res;
  }

  it('默认模板打包:文件夹层级 + 文件名正确', async () => {
    const res = await callPackage('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    // 路径: ROOT_根科目/LEAF_叶科目/2026-08-05_1200.00_差旅费_发票.pdf
    expect(names).toContain('ROOT_根科目/LEAF_叶科目/2026-08-05_1200.00_差旅费_发票.pdf');
  });

  it('自定义模板渲染各占位符', async () => {
    const res = await callPackage('?template={handler}_{status}_{year}_{subject}_{original}');
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith('张三_PAID_2026_叶科目_发票.pdf'))).toBe(true);
  });

  it('未知占位符原样保留', async () => {
    const res = await callPackage('?template={date}_报销_{original}');
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith('2026-08-05_报销_发票.pdf'))).toBe(true);
  });

  it('年度筛选:year=2099 无附件 → 404', async () => {
    const res = await callPackage('?year=2099');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('无附件');
  });

  it('Content-Disposition 双段(ASCII fallback + UTF-8)', async () => {
    const res = await callPackage('');
    const cd = res.headers.get('Content-Disposition') ?? '';
    expect(cd).toContain('filename="attachments.zip"');
    expect(cd).toContain("filename*=UTF-8''");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/api/attachments.package.test.ts`
Expected: FAIL（路由模块不存在）。

> **测试夹具核对**：实现时先读 `src/server/services/initialBudget.service.ts` 确认 `createDraft` / `submitDraft` / `approveApplication` 的真实签名（入参 `InitialBudgetPayload` 的 `lines` 字段名、`amount` 是否必填、`parentCode` 用 code 还是 id）。也读 `tests/server/businessRecord.service.test.ts` 的 `seedApprovedProject` 抄真实可用形态。若签名不同，调整夹具（这是必要的对齐，报告为 concern）。

- [ ] **Step 3: 实现打包路由**

创建 `src/app/api/projects/[id]/attachments/package/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { countForExport, listForExport } from '@/server/services/recordAttachment.service';
import {
  buildFolderPath,
  dedupeName,
  renderFilename,
  type SubjectNode,
  type TokenContext,
} from '@/lib/attachments/packagePath';

const PACKAGE_MAX_ATTACHMENTS = 500;
const DEFAULT_TEMPLATE = '{date}_{amount}_{summary}_{original}';

/**
 * GET /api/projects/:id/attachments/package?year=&template= — 按预算科目层级打包全部附件。
 * 文件夹:根→叶 walk parentId,每段 `${code}_${name}`。
 * 文件名:占位符模板(默认 {date}_{amount}_{summary}_{original})。
 * 无附件 → 404;附件数 > 500 → 413(防 OOM)。权限:project:view。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    const sp = (req.nextUrl ?? new URL(req.url)).searchParams;
    const year = sp.get('year') ? Number(sp.get('year')) : undefined;
    const template = sp.get('template') || DEFAULT_TEMPLATE;

    // 堆保护:count 前置,超上限直接 413。
    const count = await countForExport(projectId, { budgetYear: year }, user);
    if (count > PACKAGE_MAX_ATTACHMENTS) {
      return NextResponse.json(
        { error: `打包附件过多(上限 ${PACKAGE_MAX_ATTACHMENTS} 个),请按年度缩小范围` },
        { status: 413 },
      );
    }

    const rows = await listForExport(projectId, { budgetYear: year }, user);
    if (rows.length === 0) {
      return NextResponse.json({ error: '无附件' }, { status: 404 });
    }

    // 加载项目科目全树(年度无关),建 id→node map 供路径构建。
    const subjects = await prisma.budgetSubject.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, parentId: true, level: true, isLeaf: true },
    });
    const subjectById = new Map<string, SubjectNode>(subjects.map((s) => [s.id, s]));

    const [project, leafNameById] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
      Promise.resolve(
        new Map(subjects.filter((s) => s.isLeaf).map((s) => [s.id, s.name] as const)),
      ),
    ]);

    const zip = new JSZip();
    // per-folder 去重 map:folderPath → (filename → count)
    const usedByFolder = new Map<string, Map<string, number>>();

    for (const r of rows) {
      const folder = buildFolderPath(r.record.subjectId, subjectById);
      const ctx: TokenContext = {
        date: r.record.businessDate.toISOString().slice(0, 10),
        amount: r.record.amount.toFixed(2),
        handler: r.record.handler,
        subject: leafNameById.get(r.record.subjectId) ?? '',
        summary: (r.record.summary || '').slice(0, 40),
        status: r.record.status,
        year: String(r.record.budgetYear),
        original: r.attachment.fileName,
      };
      const baseName = renderFilename(template, ctx);
      let used = usedByFolder.get(folder);
      if (!used) {
        used = new Map<string, number>();
        usedByFolder.set(folder, used);
      }
      const finalName = dedupeName(baseName, used);
      const entry = folder ? `${folder}/${finalName}` : finalName;
      zip.file(entry, r.data);
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const projectName = project?.name ?? projectId;
    const zipName = encodeURIComponent(`附件_${projectName}${year ? `_${year}` : ''}.zip`);
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="attachments.zip"; filename*=UTF-8''${zipName}`,
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

Run: `npx vitest run tests/api/attachments.package.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 全量附件测试无回归**

Run:

```bash
npx vitest run tests/api/attachments.route.test.ts tests/server/recordAttachment.service.test.ts tests/lib/attachments/
```

Expected: 全 PASS。

- [ ] **Step 6: 类型检查 + lint**

Run: `npm run check-types && npm run lint`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/app/api/projects/[id]/attachments/package/route.ts tests/api/attachments.package.test.ts
git commit -m "feat(attachments): 按科目层级打包附件 API(可定制文件名模板)"
```

---

## Task 4: 客户端打包工具 + 配置 Dialog

**Files:**

- Modify: `src/lib/api/attachments.ts`（新增 `packageAttachmentsBySubject`）
- Create: `src/components/records/PackageAttachmentsDialog.tsx`

**Interfaces:**

- Consumes: `downloadFile`（`@/lib/api/client`）；Task 3 路由
- Produces:
  - `packageAttachmentsBySubject(projectId, { year?, template? }): Promise<void>`（客户端）
  - `PackageAttachmentsDialog` 组件 props `{ projectId, yearOptions: number[], open, onOpenChange }`

- [ ] **Step 1: 客户端工具函数**

在 `src/lib/api/attachments.ts` 末尾追加（import 区已有 `downloadFile`）：

```ts
/**
 * 按预算科目层级打包附件(整理报告专用)。
 * 文件夹按科目目录层级,文件名按 template 模板渲染。默认全年度;year 可选筛选。
 */
export function packageAttachmentsBySubject(
  projectId: string,
  query: { year?: number; template?: string },
): Promise<void> {
  const sp = new URLSearchParams();
  if (query.year) sp.set('year', String(query.year));
  if (query.template) sp.set('template', query.template);
  const qs = sp.toString();
  return downloadFile(
    `/api/projects/${projectId}/attachments/package${qs ? `?${qs}` : ''}`,
    'attachments.zip',
  );
}
```

- [ ] **Step 2: 实现配置 Dialog 组件**

创建 `src/components/records/PackageAttachmentsDialog.tsx`：

```tsx
'use client';

import { useMemo, useState } from 'react';
import { FolderArchive } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { packageAttachmentsBySubject } from '@/lib/api/attachments';

const DEFAULT_TEMPLATE = '{date}_{amount}_{summary}_{original}';
const ALL_YEAR = '__ALL__';
const TOKENS = [
  '{date}',
  '{amount}',
  '{handler}',
  '{subject}',
  '{summary}',
  '{status}',
  '{year}',
  '{original}',
];

// 预览用的样例数据(固定,直观展示各占位符效果)。
const PREVIEW_CTX: Record<string, string> = {
  date: '2026-08-05',
  amount: '1200.00',
  handler: '张三',
  subject: '设备购置费',
  summary: '差旅费',
  status: 'PAID',
  year: '2026',
  original: '发票.pdf',
};
const PREVIEW_FOLDER = 'ZJF_直接费/SBF_设备费/SBGZF_设备购置费';

interface PackageAttachmentsDialogProps {
  projectId: string;
  yearOptions: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PackageAttachmentsDialog({
  projectId,
  yearOptions,
  open,
  onOpenChange,
}: PackageAttachmentsDialogProps) {
  const [year, setYear] = useState<string>(ALL_YEAR);
  const [template, setTemplate] = useState<string>(DEFAULT_TEMPLATE);
  const [busy, setBusy] = useState(false);

  const previewName = useMemo(() => {
    return template.trim().replace(/\{(\w+)\}/g, (full, key: string) => {
      return PREVIEW_CTX[key] ?? full;
    });
  }, [template]);

  const handlePackage = async () => {
    setBusy(true);
    try {
      await packageAttachmentsBySubject(projectId, {
        year: year === ALL_YEAR ? undefined : Number(year),
        template: template.trim() || undefined,
      });
      toast.success('打包下载已开始');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打包失败');
    } finally {
      setBusy(false);
    }
  };

  const insertToken = (token: string) => {
    setTemplate((prev) => prev + token);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderArchive className="size-4" />
            按科目打包附件
          </DialogTitle>
          <DialogDescription>
            将项目全部科目的附件按预算目录层级整理成文件夹打包,便于整理经费报告。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">年度</label>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部年度" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_YEAR}>全部年度</SelectItem>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">文件名模板</label>
            <input
              className="flex w-full rounded-md border border-hairline-strong bg-background px-3 py-2 text-sm"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={DEFAULT_TEMPLATE}
            />
            <div className="flex flex-wrap gap-1">
              {TOKENS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => insertToken(t)}
                  className="rounded border border-hairline px-1.5 py-0.5 font-mono text-xs hover:bg-accent"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1 rounded-md bg-accent/40 p-3 text-xs">
            <p className="font-medium text-foreground">预览</p>
            <p className="break-all font-mono text-mute">
              {PREVIEW_FOLDER}/{previewName || '发票.pdf'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={handlePackage} disabled={busy}>
            {busy ? '打包中…' : '打包下载'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> **核对 shadcn 组件**：实现时先确认 `src/components/ui/dialog.tsx` 导出 `DialogDescription`、`DialogFooter`，`src/components/ui/select.tsx` 导出 `Select/SelectContent/SelectItem/SelectTrigger/SelectValue`（这些在 records 页面已有使用，大概率齐全；若 `DialogDescription` 缺失，去掉它或对齐现有 Dialog 用法）。预览用固定样例（不拉真实数据），简单稳定。

- [ ] **Step 3: 类型检查 + lint**

Run: `npm run check-types && npm run lint`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/attachments.ts src/components/records/PackageAttachmentsDialog.tsx
git commit -m "feat(attachments): 按科目打包的客户端工具 + 配置 Dialog"
```

---

## Task 5: 记录页集成 + 全量验证

**Files:**

- Modify: `src/app/(dashboard)/projects/[id]/records/page.tsx`（工具栏新增按钮 + 挂载 Dialog）

**Interfaces:**

- Consumes: Task 4 的 `PackageAttachmentsDialog`；页面已有的 `yearOptions`（记录页 useMemo 派生的年度数组）

- [ ] **Step 1: 给记录页加 import 与状态**

在 `src/app/(dashboard)/projects/[id]/records/page.tsx`：

顶部 import 区（已有 `Package` from lucide、`exportAttachmentsZip`）追加：

```ts
import { FolderArchive } from 'lucide-react';
import { PackageAttachmentsDialog } from '@/components/records/PackageAttachmentsDialog';
```

在 `BusinessRecordsPageInner` 内（与 `attachmentTarget` 等状态同级）追加：

```ts
const [packageOpen, setPackageOpen] = useState(false);
```

- [ ] **Step 2: 工具栏新增按钮**

定位现有「导出附件(zip)」按钮（`Package` 图标，约 line 757-765），在其**之后**（同一 flex 容器内）追加：

```tsx
<Button variant="outline" size="sm" onClick={() => setPackageOpen(true)}>
  <FolderArchive className="size-4" />
  按科目打包
</Button>
```

- [ ] **Step 3: 挂载 PackageAttachmentsDialog**

定位 `AttachmentSheet` 挂载处（Task 9 of previous PR 加的），在其后追加：

```tsx
<PackageAttachmentsDialog
  projectId={projectId}
  yearOptions={yearOptions}
  open={packageOpen}
  onOpenChange={setPackageOpen}
/>
```

> **核对 `yearOptions`**：实现时 `git grep -n "yearOptions" "src/app/(dashboard)/projects/[id]/records/page.tsx"` 确认变量名与作用域（它在 `BusinessRecordsPageInner` 内通过 useMemo 派生，作用域内可用）。若名不同，用真实名。

- [ ] **Step 4: 类型检查 + lint + 全量测试**

Run:

```bash
npm run check-types
npm run lint
npm test
```

Expected: 全 PASS（含新 package 测试，且现有测试无回归）。

- [ ] **Step 5: 浏览器手动验证**

Run: `npm run dev`（如已在跑则直接访问）

1. 进任意项目「业务记录」页 → 工具栏看到「按科目打包」按钮
2. 点击 → Dialog 弹出 → 改模板 → 预览实时变化
3. 点「打包下载」→ 浏览器下载 zip → 解压确认文件夹层级正确、文件名按模板
4. 年度选一个无附件的年份 → 应 toast 报错（404 无附件）

- [ ] **Step 6: Commit**

```bash
git add src/app/(dashboard)/projects/[id]/records/page.tsx
git commit -m "feat(attachments): 记录页工具栏新增按科目打包入口"
```

---

## Notes for the Implementer

- **测试夹具 `seedApprovedProject`**：本计划 Task 3 给了一个 createDraft/submit/approve 的草案，但 `initialBudget.service.ts` 的真实签名是权威——实现 Task 3 前先读它 + `tests/server/businessRecord.service.test.ts` 的 `seedApprovedProject`，对齐真实入参（尤其 `InitialBudgetPayload.lines` 的字段名）。这是必要的对齐，不是偏离。
- **`Prisma.Decimal`**：listForExport 返回的 `amount` 是 `Prisma.Decimal`，`.toFixed(2)` 可用（与 `receipt.service.ts` 的 `fromStored(...).toFixed(2)` 一致）。
- **`leafNameById` 的 Promise.resolve**：Task 3 路由里我用 `Promise.resolve(new Map(...))` 放进 `Promise.all` 是为了和 `project` 查询并行——其实它是纯内存计算无需异步，可以直接 `const leafNameById = new Map(...)` 放 Promise.all 外。实现时简化即可（不影响正确性）。
- **不要碰现有 export 路由**：Task 2 扩展 listForExport 字段后，现有扁平 export route 仍正常（它只用 businessDate/summary/handler，多出字段忽略）。
- **Dialog 组件 API**：若 `DialogDescription` 在现有 `dialog.tsx` 未导出，去掉它（description 非必需），对齐 records 页其他 Dialog 的写法。
