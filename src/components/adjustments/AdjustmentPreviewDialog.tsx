'use client';

import dynamic from 'next/dynamic';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

// viewer 主体(preset/renderer/Worker 装配)仅浏览器加载:禁用 SSR 并给骨架占位。
const AdjustmentDocxViewer = dynamic(() => import('./AdjustmentDocxViewer'), {
  ssr: false,
  loading: () => <Skeleton className="min-h-40 flex-1" />,
});

/** 预览目标的最小字段(调用方传整行亦可,这里只取渲染所需)。 */
export interface AdjustmentPreviewTarget {
  id: string;
  year: number;
  kind?: 'ADJUST' | 'ALLOCATE';
}

interface AdjustmentPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** 当前预览的调整单;null 时 Dialog 关闭。 */
  adjustment: AdjustmentPreviewTarget | null;
}

/**
 * 调整单 docx 在线预览弹窗(§issue17)。
 * Shell 只负责 Dialog 布局与标题;取数、维度切换、打印/下载在 viewer 主体内。
 */
export function AdjustmentPreviewDialog({
  open,
  onOpenChange,
  projectId,
  adjustment,
}: AdjustmentPreviewDialogProps) {
  return (
    <Dialog
      open={open && !!adjustment}
      onOpenChange={(o) => {
        if (!o) onOpenChange(false);
      }}
    >
      <DialogContent className="flex h-[85vh] w-full max-w-5xl flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {adjustment ? `预算调整单预览 · ${adjustment.year} 年度` : '预算调整单预览'}
          </DialogTitle>
        </DialogHeader>
        {/* 仅在有关联目标时挂载,关闭即卸载(Worker/WASM 随之销毁)。 */}
        {adjustment && (
          <AdjustmentDocxViewer
            className="flex-1"
            projectId={projectId}
            adjId={adjustment.id}
            kind={adjustment.kind ?? 'ADJUST'}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
