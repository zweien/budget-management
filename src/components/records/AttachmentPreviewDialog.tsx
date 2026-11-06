'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Download } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  downloadAttachment,
  fetchAttachmentBlob,
  type AttachmentMeta,
  type AttachmentOwnerKind,
} from '@/lib/api/attachments';

// file-viewer 装配(Worker/WASM)只能在浏览器加载:禁用 SSR,骨架占位。
const ViewerCanvas = dynamic(() => import('@/components/file-viewer/ViewerCanvas'), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

/**
 * 预览白名单(双通道):
 * - 图片/PDF 按 contentType 前缀(浏览器原生预览);
 * - Office 文档/表格按文件名扩展名——file-viewer 的格式识别本就只认文件名
 *   后缀,且上传时扩展名/MIME 已双白名单校验一致。docx/xlsx 渲染资产
 *   (public/file-viewer/vendor/{docx,xlsx})已自托管,doc/xls 老格式由
 *   renderer-word 内置二进制解析器 / BIFF 表格渲染器覆盖。
 * ppt/pptx 渲染资产未自托管(见 scripts/copy-file-viewer-assets.mjs 裁剪),
 * 维持"不支持在线预览,请下载"兜底。
 */
const SUPPORTED_PREFIXES = ['image/', 'application/pdf'];
const SUPPORTED_OFFICE_EXTENSIONS = ['.doc', '.docx', '.xls', '.xlsx'];

/** Office 附件经 file-viewer 渲染的追加 options:docx 页式预览与调整单审批表同款观感。 */
const OFFICE_VIEWER_OPTIONS = { docx: { visualPagination: true } };

interface AttachmentPreviewDialogProps {
  projectId: string;
  /** 宿主 id(业务记录或到账流水)。 */
  ownerId: string;
  /** 宿主类型(决定取数路径)。 */
  ownerKind: AttachmentOwnerKind;
  /** 当前预览的附件;null 时 Dialog 关闭。 */
  attachment: AttachmentMeta | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * 预览 Dialog(§issue18):渲染层统一为 file-viewer(与调整单预览同一底座)。
 * 取数鉴权附件 blob → ArrayBuffer 直喂 ViewerCanvas,不再有 <img>/<iframe>
 * 分支与 object URL 生命周期管理;图片/PDF/Office 文档表格由内建基线 +
 * preset-office 覆盖(白名单见上)。
 *
 * 交互与失败提示沿用现状:白名单外仍提示"不支持在线预览"+ 下载兜底。
 *
 * React 19 的 react-hooks `set-state-in-effect` 规则:setState 全部放进 fetch 的
 * 异步回调;加载中由渲染期派生(有附件、白名单内、尚无 buffer 与 error)。
 */
export function AttachmentPreviewDialog({
  projectId,
  ownerId,
  ownerKind,
  attachment,
  onOpenChange,
}: AttachmentPreviewDialogProps) {
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  /** PDF 的 blob URL(原生查看器渲染);切换/关闭时 revoke。 */
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attachmentId = attachment?.id;
  const contentType = attachment?.contentType ?? '';
  const fileName = attachment?.fileName ?? '';
  const supported =
    SUPPORTED_PREFIXES.some((p) => contentType.startsWith(p)) ||
    SUPPORTED_OFFICE_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));

  const isPdf = contentType === 'application/pdf';

  useEffect(() => {
    if (!attachmentId || !supported) return;
    let cancelled = false;
    let revokeUrl: string | null = null;
    fetchAttachmentBlob(projectId, ownerId, attachmentId, ownerKind)
      .then((blob) => {
        if (cancelled) return;
        // PDF 走浏览器原生查看器(blob URL + iframe):file-viewer 的 PDF 渲染器
        // 会把缓冲转移给 WASM Worker,React StrictMode 双挂载下第二次初始化拿到
        // 已分离缓冲而失败(dev 复现"detached ArrayBuffer");原生渲染更稳且自带
        // 缩放/打印。其余格式维持 ArrayBuffer 直喂。
        if (isPdf) {
          revokeUrl = URL.createObjectURL(blob);
          setPdfUrl(revokeUrl);
          setBuffer(null);
          setError(null);
          return;
        }
        return blob.arrayBuffer().then((buf) => {
          if (!cancelled) {
            setBuffer(buf);
            setError(null);
          }
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBuffer(null);
          setError(e instanceof Error ? e.message : '加载失败');
        }
      });
    return () => {
      // 卸载/切换附件:作废飞行中回调,回收字节引用与 blob URL。
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
      setBuffer(null);
      setPdfUrl(null);
      setError(null);
    };
  }, [attachmentId, projectId, ownerId, ownerKind, supported, isPdf]);

  // 渲染期派生 loading:支持预览、非 PDF、尚无 buffer 与 error = 加载中(PDF 以 pdfUrl 为准)。
  const loading =
    !!attachment && supported && !isPdf && buffer === null && error === null && !pdfUrl;

  return (
    <Dialog open={!!attachment} onOpenChange={onOpenChange}>
      {/* 近全屏:图片/PDF 预览以看清楚为先;上限 1440px 防超宽屏拉伸留白过大。 */}
      <DialogContent className="flex h-[92vh] max-w-[min(96vw,1440px)] flex-col sm:max-w-[min(96vw,1440px)]">
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
              ownerId={ownerId}
              ownerKind={ownerKind}
              attachment={attachment}
            />
          ) : !supported ? (
            <FallbackMsg
              msg="该格式不支持在线预览,请下载"
              projectId={projectId}
              ownerId={ownerId}
              ownerKind={ownerKind}
              attachment={attachment}
            />
          ) : isPdf && pdfUrl ? (
            // 浏览器原生 PDF 查看器(与下载字节同源,带鉴权 blob URL)。
            <iframe src={pdfUrl} title={`预览:${fileName}`} className="h-full w-full" />
          ) : buffer && attachment ? (
            <ViewerCanvas
              // 附件切换即重挂载,重置 viewer 内部 Worker 状态。
              key={attachment.id}
              buffer={buffer}
              filename={fileName}
              viewerOptions={OFFICE_VIEWER_OPTIONS}
              // 损坏/不可渲染文件:下载成功但渲染失败时,把错误交给既有
              // 错误兜底(提示 + 下载原文件),避免"渲染中"遮罩永不消失。
              onError={setError}
              className="h-full w-full"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 错误/不支持态的统一提示:文案 + 下载按钮兜底。 */
function FallbackMsg({
  msg,
  projectId,
  ownerId,
  ownerKind,
  attachment,
}: {
  msg: string;
  projectId: string;
  ownerId: string;
  ownerKind: AttachmentOwnerKind;
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
            downloadAttachment(projectId, ownerId, attachment.id, ownerKind).catch((e: unknown) =>
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
