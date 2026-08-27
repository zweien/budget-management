'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Printer, RotateCw } from 'lucide-react';
import { toast } from 'sonner';

// 本文件整体经外层 next/dynamic(ssr:false)引入,ViewerCanvas(file-viewer 装配)
// 因此也不会进入 SSR 打包求值路径。
import { ViewerCanvas, type ViewerCanvasProps } from '@/components/file-viewer/ViewerCanvas';
import type { FileViewerHandle } from '@file-viewer/react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchFile } from '@/lib/api/client';

/** 导出维度(与 adjustmentExport.service 的 ExportDimension 对应)。 */
type Dimension = 'total' | 'annual';

/** 已加载完成的文档:buf 与其归属的 dim/attempt 绑定,用于渲染期识别过期数据。 */
interface LoadedDoc {
  dim: Dimension;
  attempt: number;
  buf: ArrayBuffer;
}

interface AdjustmentDocxViewerProps {
  projectId: string;
  adjId: string;
  /** 调整单类型:ALLOCATE(追加下达)只有年度维度文档。 */
  kind: 'ADJUST' | 'ALLOCATE';
  className?: string;
}

/**
 * 调整单 docx 在线预览画布(§issue17)。
 *
 * - 数据:fetchFile(带鉴权 header)拉取导出接口返回的 docx → ArrayBuffer 直喂
 *   FileViewer,不经临时 URL,"下载"拿到的字节与直接点导出完全一致。
 * - 维度切换/重试都会重新拉取并重挂载 viewer(key 重置其内部 Worker 状态)。
 *
 * React 19 react-hooks `set-state-in-effect`:setState 只出现在 fetch 异步回调,
 * 加载/渲染中的判定全部渲染期派生(loaded 过期 / 未就绪),与
 * AttachmentPreviewDialog 同一套模式。
 */
export default function AdjustmentDocxViewer({
  projectId,
  adjId,
  kind,
  className,
}: AdjustmentDocxViewerProps) {
  // ALLOCATE 单的 total 维度行金额恒为 0,无文书意义——与列表页"导出总预算"
  // 按钮的可见性规则(kind !== 'ALLOCATE')保持一致。
  const dims: Dimension[] = kind === 'ALLOCATE' ? ['annual'] : ['total', 'annual'];

  const [dim, setDim] = useState<Dimension>(dims[0]);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<LoadedDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** viewer 报告 load-complete 的文档标识;与当前请求一致才解锁打印。 */
  const [readyId, setReadyId] = useState<string | null>(null);

  const viewerRef = useRef<FileViewerHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFile(`/api/projects/${projectId}/adjustments/${adjId}/export?dim=${dim}`)
      .then(({ blob }) => blob.arrayBuffer())
      .then((buf) => {
        if (!cancelled) {
          setLoaded({ dim, attempt, buf });
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoaded(null);
          setError(e instanceof Error ? e.message : '加载失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, adjId, dim, attempt]);

  // 当前请求标识(挂载 viewer 的 key):维度或重试号变化即视为新文档。
  const requestId = `${adjId}:${dim}:${attempt}`;
  const docReady = readyId === requestId;

  // 渲染期派生:请求中/已切维度但新文档未到/上次失败后的重试中,均视为加载中。
  const pending = !!error || !loaded || loaded.dim !== dim || loaded.attempt !== attempt;

  // 独占注册表:审批表预览只需要 docx,preset-office + replace 起步最干净。
  const viewerOptions = useMemo<ViewerCanvasProps['viewerOptions']>(
    () => ({
      rendererMode: 'replace' as const,
      // 页式预览贴合"审批表"纸质排版观感。
      docx: { visualPagination: true },
    }),
    [],
  );

  const filename = dim === 'total' ? '总预算调整.docx' : '年度预算调整.docx';

  const handleDownload = async () => {
    try {
      await viewerRef.current?.downloadOriginalFile();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '下载失败');
    }
  };

  const handlePrint = async () => {
    try {
      await viewerRef.current?.printRenderedHtml();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打印失败');
    }
  };

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2">
        {dims.length > 1 ? (
          <Tabs value={dim} onValueChange={(v) => setDim(v as Dimension)}>
            <TabsList>
              <TabsTrigger value="total">总预算维度</TabsTrigger>
              <TabsTrigger value="annual">年度维度</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          <span className="text-sm text-mute">年度维度</span>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!docReady}
            onClick={() => void handlePrint()}
          >
            <Printer className="size-4" />
            打印
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!docReady}
            onClick={() => void handleDownload()}
          >
            <Download className="size-4" />
            下载
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <p role="alert" className="text-sm text-error-deep">
              预览失败:{error}
            </p>
            <Button variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
              <RotateCw className="size-4" />
              重试
            </Button>
          </div>
        ) : pending ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Skeleton className="h-[60%] w-[80%]" />
            <p className="flex items-center gap-2 text-sm text-mute">
              <Loader2 className="size-4 animate-spin" />
              正在生成文书…
            </p>
          </div>
        ) : (
          <>
            {/* key 随维度/重试变化而重挂载,确保 Worker 状态与当前文档一一对应。
                渲染中遮罩与错误上浮由 ViewerCanvas 内部处理。 */}
            <ViewerCanvas
              key={requestId}
              ref={viewerRef}
              buffer={loaded.buf}
              filename={filename}
              viewerOptions={viewerOptions}
              onReady={() => setReadyId(requestId)}
              onError={setError}
              className="h-full w-full"
            />
          </>
        )}
      </div>
    </div>
  );
}
