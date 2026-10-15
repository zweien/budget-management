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
} from '@/lib/api/attachments';

// file-viewer 装配(Worker/WASM)只能在浏览器加载:禁用 SSR,骨架占位。
const ViewerCanvas = dynamic(() => import('@/components/file-viewer/ViewerCanvas'), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

/**
 * 预览白名单:浏览器原生支持的预览前缀。
 * 本次仅把渲染层切换为 file-viewer(§issue18),类型范围不扩大;
 * 放开 docx/xlsx 附件上传是另一个议题,届时白名单放开即得在线预览。
 */
const SUPPORTED_PREFIXES = ['image/', 'application/pdf'];

interface AttachmentPreviewDialogProps {
  projectId: string;
  recordId: string;
  /** 当前预览的附件;null 时 Dialog 关闭。 */
  attachment: AttachmentMeta | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * 预览 Dialog(§issue18):渲染层统一为 file-viewer(与调整单预览同一底座)。
 * 取数鉴权附件 blob → ArrayBuffer 直喂 ViewerCanvas,不再有 <img>/<iframe>
 * 分支与 object URL 生命周期管理;图片/PDF 由内建基线 + preset-office 覆盖。
 *
 * 交互与失败提示沿用现状:白名单外仍提示"不支持在线预览"+ 下载兜底。
 *
 * React 19 的 react-hooks `set-state-in-effect` 规则:setState 全部放进 fetch 的
 * 异步回调;加载中由渲染期派生(有附件、白名单内、尚无 buffer 与 error)。
 */
export function AttachmentPreviewDialog({
  projectId,
  recordId,
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
  const supported = SUPPORTED_PREFIXES.some((p) => contentType.startsWith(p));

  const isPdf = contentType === 'application/pdf';

  useEffect(() => {
    if (!attachmentId || !supported) return;
    let cancelled = false;
    let revokeUrl: string | null = null;
    fetchAttachmentBlob(projectId, recordId, attachmentId)
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
  }, [attachmentId, projectId, recordId, supported, isPdf]);

  // 渲染期派生 loading:支持预览、非 PDF、尚无 buffer 与 error = 加载中(PDF 以 pdfUrl 为准)。
  const loading =
    !!attachment && supported && !isPdf && buffer === null && error === null && !pdfUrl;

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
          ) : isPdf && pdfUrl ? (
            // 浏览器原生 PDF 查看器(与下载字节同源,带鉴权 blob URL)。
            <iframe src={pdfUrl} title={`预览:${fileName}`} className="h-full w-full" />
          ) : buffer && attachment ? (
            <ViewerCanvas
              // 附件切换即重挂载,重置 viewer 内部 Worker 状态。
              key={attachment.id}
              buffer={buffer}
              filename={fileName}
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
