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
  const [error, setError] = useState<string | null>(null);

  const attachmentId = attachment?.id;
  const contentType = attachment?.contentType ?? '';
  const fileName = attachment?.fileName ?? '';
  const supported = SUPPORTED_PREFIXES.some((p) => contentType.startsWith(p));

  useEffect(() => {
    if (!attachmentId || !supported) return;
    let cancelled = false;
    fetchAttachmentBlob(projectId, recordId, attachmentId)
      .then((blob) => blob.arrayBuffer())
      .then((buf) => {
        if (!cancelled) {
          setBuffer(buf);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBuffer(null);
          setError(e instanceof Error ? e.message : '加载失败');
        }
      });
    return () => {
      // 卸载/切换附件:作废飞行中回调,清字节引用(ArrayBuffer 无 object URL 需 revoke)。
      cancelled = true;
      setBuffer(null);
      setError(null);
    };
  }, [attachmentId, projectId, recordId, supported]);

  // 渲染期派生 loading:支持预览、有附件、尚无 buffer 与 error = 加载中。
  const loading = !!attachment && supported && buffer === null && error === null;

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
