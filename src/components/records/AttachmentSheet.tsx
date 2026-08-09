'use client';

import { useEffect, useState } from 'react';
import { Paperclip, Download, Trash2, Plus, FileWarning, Eye } from 'lucide-react';
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
import { AttachmentPreviewDialog } from '@/components/records/AttachmentPreviewDialog';

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
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentMeta | null>(null);

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
  }, [open, record?.id, projectId]);

  if (!record) return null;

  const readonly = !canWrite || record.isVoid;

  const handleFiles = async (files: FileList | File[]) => {
    if (!record || readonly) return;
    const arr = Array.from(files);
    // 大小上限以服务端为准(env.MAX_ATTACHMENT_BYTES):超限服务端返回 413,
    // uploadAttachment 的失败分支会把服务端文案(含真实上限 humanFileSize)经 toast 透出。
    // 不在客户端做硬编码预拦截,避免与 env 漂移。
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
    <>
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
              <p className="text-xs text-mute">支持图片 / PDF / Office 文档</p>
              <input
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
                    <span className="shrink-0 text-xs text-mute">
                      {humanFileSize(att.sizeBytes)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label="预览"
                      onClick={() => setPreviewAttachment(att)}
                    >
                      <Eye className="size-4" />
                    </Button>
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
      <AttachmentPreviewDialog
        projectId={projectId}
        recordId={record.id}
        attachment={previewAttachment}
        onOpenChange={(o) => !o && setPreviewAttachment(null)}
      />
    </>
  );
}
