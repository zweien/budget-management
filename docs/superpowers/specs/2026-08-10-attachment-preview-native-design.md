# 附件预览(浏览器原生) — 设计文档

- **日期**: 2026-08-10
- **状态**: 已确认设计,待实现
- **目标**: 在附件抽屉内直接预览报销凭证(图片/PDF),无需下载;Office 类提示下载
- **依赖**: 附件功能(PR #6)、按科目打包(PR #7),均已合并到 main
- **背景**: 曾尝试集成 `@file-viewer/react-full`,但因 (1) PDF/DOCX 的 pdfjs worker 与 Turbopack 运行期不兼容、(2) 库的 160MB vendored wasm 触发 Mimosa L3 强制阻塞所有 commit,两重阻断下放弃,改用浏览器原生能力

## 决策摘要

| 维度                | 选择                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| 渲染方式            | **浏览器原生**(零第三方库)                                           |
| 图片                | `<img src={blobUrl}>`                                                |
| PDF                 | `<iframe src={blobUrl}>`(Chromium/Firefox 内置 PDFium 查看器)        |
| Office(doc/xls/ppt) | 不支持预览 → 提示「该格式不支持在线预览,请下载」+ 下载按钮           |
| 取数                | 鉴权 fetch 拉 Blob → `URL.createObjectURL` → 传给 `<img>`/`<iframe>` |
| 入口                | 附件抽屉(AttachmentSheet)每行下载按钮旁加「眼睛」预览按钮            |
| 预览载体            | shadcn `Dialog`(`sm:max-w-4xl`,80vh)                                 |
| 鉴权                | 复用前端 `bootstrapMockUser` header / SSO 自动 cookie                |
| 权限                | 复用 `project:view`(与下载一致)                                      |

## 1. 为什么用原生而非库

放弃 file-viewer 的两重阻断:

1. **运行期**:PDF/DOCX 依赖 `pdfjs-dist` web worker,Turbopack 把 worker JS 打进 chunk 时破坏语法(`Invalid or unexpected token`),worker 加载失败 → PDF/DOCX 空渲染。图片虽可用,但凭证场景 PDF 同样关键。
2. **工作流**:file-viewer 的 160MB vendored wasm(`occt-import-js.js`/`dwg-worker.js`/`libredwg-web.js` 等 emscripten 产物)触发 Mimosa L3 的 SSRF/命令注入启发式误报,且 Mimosa 是**强制关卡**(`--no-verify` 也拦),导致项目里只要有这些文件就**无法 commit 任何东西**。

原生方案零依赖、零 worker、零 vendored wasm,同时绕开两个阻断。代价:Office(doc/xls/ppt)不支持在线预览——但凭证主流是扫描件图片和 PDF,Office 相对少,走下载兜底可接受。

## 2. 取数:Blob URL

附件下载路由 `/api/projects/[id]/records/[recordId]/attachments/[attId]` 返回 `Content-Disposition: attachment`(强制下载)。若直接把该 URL 给 `<iframe>`,浏览器会下载而非渲染。

**Blob URL 方案绕开此问题**:

1. 前端鉴权 fetch(`bootstrapMockUser` header / SSO 自动 cookie)拉附件为 Blob
2. `URL.createObjectURL(blob)` 生成 `blob:` URL
3. `<img src={blobUrl}>` 或 `<iframe src={blobUrl}>`
4. Blob URL 是纯前端构造,**不带响应头** → Content-Disposition 不生效 → 浏览器直接渲染
5. Dialog 关闭/切换附件时 `URL.revokeObjectURL(blobUrl)` 释放内存

两鉴权模式都工作(鉴权由我们的 fetch 处理,`<img>`/`<iframe>` 只消费 blob URL,不发网络请求)。

## 3. 入口与 UI

### 入口

附件抽屉(`AttachmentSheet`)每行附件,下载按钮旁新增「眼睛」预览按钮(`Eye` 图标)。点击在上层弹 Dialog。

预览按钮**始终可见**(预览是查阅,与下载同级,不受 canWrite/isVoid 限制)。

### 预览 Dialog

```
┌─ 预览:发票.pdf ────────────────────────────────[×]┐
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │                                              │ │
│  │        <img> 或 <iframe> 渲染区              │ │
│  │        (图片直接显示 / PDF 内置查看器)        │ │
│  │                                              │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  [该格式不支持预览,请下载] + [下载原文件]          │  ← 仅 Office 显示
└────────────────────────────────────────────────────┘
```

- shadcn `Dialog`,`sm:max-w-4xl`,body 高度 `80vh`
- 标题:`预览:<文件名>`
- **按 contentType 分支渲染**:
  - 图片(`image/*`)→ `<img src={blobUrl} className="max-h-full max-w-full object-contain mx-auto">`
  - PDF(`application/pdf`)→ `<iframe src={blobUrl} className="h-full w-full">`(浏览器内置 PDF 查看器,支持翻页/缩放/下载)
  - 其他(Office 等)→ 不 fetch,直接显示「该格式不支持在线预览」+ 下载按钮(省一次无谓请求)
- 加载态:fetch 字节时 spinner/Skeleton
- 错误态:fetch 失败 → 提示 + 下载按钮
- 关闭:点 × 或 Esc;组件卸载 revokeObjectURL

## 4. 客户端工具

`src/lib/api/attachments.ts` 新增 `fetchAttachmentBlobUrl`(与 file-viewer 方案相同,已验证可用):

```ts
/** 拉取附件字节为 Blob URL(供 <img>/<iframe> 预览)。
 *  鉴权同 downloadAttachment;返回 createObjectURL 生成的 blob: URL,
 *  调用方负责在关闭/切换时 revokeObjectURL。 */
export async function fetchAttachmentBlobUrl(
  projectId: string,
  recordId: string,
  attId: string,
): Promise<string> {
  const mockUserId = await bootstrapMockUser();
  const res = await fetch(`/api/projects/${projectId}/records/${recordId}/attachments/${attId}`, {
    headers: {
      ...(mockUserId ? { 'x-mock-user-id': mockUserId } : {}),
      Accept: 'application/octet-stream',
    },
  });
  if (!res.ok) {
    /* 解析 {error} */ throw new Error(msg);
  }
  return URL.createObjectURL(await res.blob());
}
```

## 5. 组件结构

### 新增 `AttachmentPreviewDialog.tsx`

```tsx
'use client';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  downloadAttachment,
  fetchAttachmentBlobUrl,
  type AttachmentMeta,
} from '@/lib/api/attachments';

/** Office 等不支持原生预览的格式 → 直接展示下载提示,不 fetch。 */
const SUPPORTED_PREFIXES = ['image/', 'application/pdf'];

interface Props {
  projectId: string;
  recordId: string;
  attachment: AttachmentMeta | null;
  onOpenChange: (open: boolean) => void;
}

export function AttachmentPreviewDialog({ projectId, recordId, attachment, onOpenChange }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attachmentId = attachment?.id;
  const contentType = attachment?.contentType ?? '';
  const supported = SUPPORTED_PREFIXES.some((p) => contentType.startsWith(p));

  useEffect(() => {
    if (!attachmentId || !supported) return; // 不支持的格式不 fetch
    let cancelled = false;
    let createdUrl: string | null = null;
    fetchAttachmentBlobUrl(projectId, recordId, attachmentId)
      .then((url) => {
        createdUrl = url;
        if (!cancelled) {
          setBlobUrl(url);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBlobUrl(null);
          setError(e instanceof Error ? e.message : '加载失败');
        }
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      setBlobUrl(null);
      setError(null);
    };
  }, [attachmentId, projectId, recordId, supported]);

  const loading = !!attachment && supported && blobUrl === null && error === null;

  return (
    <Dialog open={!!attachment} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-full max-w-4xl flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">预览:{attachment?.fileName ?? ''}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 items-center justify-center overflow-hidden">
          {loading ? (
            <Skeleton className="h-full w-full" />
          ) : error ? (
            <FallbackMsg
              msg={`预览失败:${error}`}
              projectId={projectId}
              recordId={recordId}
              attachment={attachment}
            />
          ) : !supported ? (
            <FallbackMsg
              msg="该格式不支持在线预览,请下载"
              projectId={projectId}
              recordId={recordId}
              attachment={attachment}
            />
          ) : blobUrl && attachment ? (
            contentType.startsWith('image/') ? (
              <img
                src={blobUrl}
                alt={attachment.fileName}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <iframe
                src={blobUrl}
                title={attachment.fileName}
                className="h-full w-full border-0"
              />
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FallbackMsg({
  msg,
  projectId,
  recordId,
  attachment,
}: {
  msg: string;
  projectId: string;
  recordId: string;
  attachment: AttachmentMeta | null;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p role="alert" className="text-error-deep">
        {msg}
      </p>
      {attachment && (
        <Button
          variant="outline"
          onClick={() =>
            downloadAttachment(projectId, recordId, attachment.id).catch((e: unknown) =>
              toast.error(e instanceof Error ? e.message : '下载失败'),
            )
          }
        >
          <Download className="size-4" />
          下载原文件
        </Button>
      )}
    </div>
  );
}
```

> React 19 `set-state-in-effect` 规则:setState 全在异步回调 + cleanup(异步执行,不受规则约束)。loading 派生自渲染期。

### 修改 `AttachmentSheet.tsx`

- lucide import 加 `Eye`
- import `AttachmentPreviewDialog`
- 状态 `const [previewAttachment, setPreviewAttachment] = useState<AttachmentMeta | null>(null)`
- 每行下载按钮**前**加预览按钮(`<Eye>`,ghost icon size-7,`onClick={() => setPreviewAttachment(att)}`,不限 canWrite)
- return 用 Fragment 包裹,挂载 `<AttachmentPreviewDialog projectId recordId={record.id} attachment={previewAttachment} onOpenChange={...} />`

## 6. 权限与安全

- **权限**:复用 `project:view`(与下载一致)
- **鉴权**:前端 fetch 注入,`<img>`/`<iframe>` 只消费 blob URL,不发网络请求
- **Mimosa 约束**(服务端仅 http/https + 拒绝私网):本方案零服务端改动、零第三方 wasm,viewer 不发网络请求 → 自然满足
- **内存**:Blob URL 在 Dialog 关闭/切换时 revokeObjectURL 释放

## 7. 测试策略

UI 组件手动浏览器验证(项目惯例,无单测)。验证矩阵:

| 场景                | 验证点                                 |
| ------------------- | -------------------------------------- |
| PNG/JPG 图片        | `<img>` 渲染,尺寸自适应                |
| PDF                 | `<iframe>` 内置查看器渲染,可翻页/缩放  |
| docx/xlsx           | 显示「不支持预览」+ 下载按钮(不 fetch) |
| fetch 失败(401/404) | 错误态 + 下载按钮                      |
| 关闭重开            | revoke 旧 URL,可预览其他附件           |
| 作废记录附件        | 预览按钮可见、可预览                   |
| Mock/SSO 两模式     | 鉴权都能拿到字节                       |

## 8. 风险

| 风险                                      | 概率 | 影响         | 缓解                                                                |
| ----------------------------------------- | ---- | ------------ | ------------------------------------------------------------------- |
| `<iframe src=blob:>` 某些浏览器不渲染 PDF | 低   | PDF 无法预览 | Chromium/Firefox/Edge 都内置 PDFium,标准行为;Safari 也支持;实测确认 |
| Office 用户期望预览                       | 中   | 体验降级     | 凭证主流是图片/PDF;Office 走下载,提示文案明确                       |
| CSP 限制 iframe blob                      | 低   | PDF 不渲染   | 项目无严格 CSP;若有,加 `frame-src blob:`                            |

## 9. 涉及文件

**新增**:`src/components/records/AttachmentPreviewDialog.tsx`
**修改**:`src/components/records/AttachmentSheet.tsx`(预览按钮 + Dialog 挂载)、`src/lib/api/attachments.ts`(`fetchAttachmentBlobUrl`)

零依赖、零资源、零服务端改动。

## 10. 验收标准

1. 抽屉每行有预览按钮,点击弹 Dialog
2. 图片/PDF 各实测一个能渲染(PDF 可翻页)
3. Office 显示不支持提示 + 下载按钮(不 fetch)
4. fetch 失败显示错误态 + 下载
5. 关闭后 revoke,可重开预览其他附件
6. Mock/SSO 两模式都能拿到字节
7. 作废记录附件可预览
