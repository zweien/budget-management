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

/**
 * 浏览器原生支持的预览前缀。Office(doc/xls/ppt)无原生预览 → 直接走下载提示,不 fetch。
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
 * 预览 Dialog:鉴权 fetch 拉 Blob → createObjectURL → 按 contentType 用 <img>/<iframe> 渲染。
 * Office 等不支持原生预览的格式直接展示下载提示(不 fetch,省一次无谓请求)。
 *
 * React 19 的 react-hooks `set-state-in-effect` 规则:setState 全部放进 fetch 的异步回调,
 * cleanup(异步执行,不受规则约束)负责 revoke + 清状态。loading 由渲染期派生。
 */
export function AttachmentPreviewDialog({
  projectId,
  recordId,
  attachment,
  onOpenChange,
}: AttachmentPreviewDialogProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attachmentId = attachment?.id;
  const contentType = attachment?.contentType ?? '';
  const supported = SUPPORTED_PREFIXES.some((p) => contentType.startsWith(p));

  useEffect(() => {
    if (!attachmentId || !supported) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    fetchAttachmentBlobUrl(projectId, recordId, attachmentId)
      .then((url) => {
        // 无论是否已取消都记录 url:若 cleanup 已跑(取消),这里立即 revoke,
        // 防止飞行中 fetch resolve 后创建的 blob URL 无人释放(最大 50MB 泄漏)。
        createdUrl = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setBlobUrl(url);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBlobUrl(null);
          setError(e instanceof Error ? e.message : '加载失败');
        }
      });
    return () => {
      // cleanup 在卸载/切换附件时执行:revoke blob URL 释放大文件字节引用,
      // 并清状态。cancelled 防止已卸载/已切换的 fetch 回调 setState。
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      setBlobUrl(null);
      setError(null);
    };
  }, [attachmentId, projectId, recordId, supported]);

  // 渲染期派生 loading:支持预览、有附件、尚无 blobUrl 与 error = 加载中。
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
