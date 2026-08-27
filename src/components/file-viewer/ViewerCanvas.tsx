'use client';

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

// 本文件是 file-viewer 的唯一浏览器侧装配点:调用方必须以
// next/dynamic(ssr:false) 或"本身已被 ssr:false 动态引入"的方式加载,
// 保证 preset/renderer(含 Web Worker 与 WASM 装配)不进入 SSR 求值路径。
import FileViewer, { type FileViewerHandle } from '@file-viewer/react';
import officePreset from '@file-viewer/preset-office';
import type { ViewerOptions } from '@file-viewer/react';

export interface ViewerCanvasProps {
  buffer: ArrayBuffer;
  /** 格式识别依据:file-viewer 按文件名后缀路由渲染器(勿传 MIME type,见下)。 */
  filename: string;
  className?: string;
  /** 渲染完成(load-complete)回调。 */
  onReady?: () => void;
  /** viewer 内部错误上浮(state.error),message 已做可读化。 */
  onError?: (message: string) => void;
  /**
   * 追加/覆盖默认 options。
   * 默认:preset-office + 浅色主题 + 内建基线 extend(图片等轻格式由内建基线覆盖,
   * office/pdf 重格式由 preset 增强)。需独占注册表时传 rendererMode:'replace'。
   */
  viewerOptions?: ViewerOptions;
}

/**
 * file-viewer 渲染画布(§issue17/§issue18 共用底座)。
 * 内置"渲染中"遮罩与错误上浮;父组件只管取数与业务 UI。
 */
export const ViewerCanvas = forwardRef<FileViewerHandle, ViewerCanvasProps>(function ViewerCanvas(
  { buffer, filename, className, onReady, onError, viewerOptions },
  ref,
) {
  const [ready, setReady] = useState(false);
  // key:buffer/filename 变化即重挂载,重置 viewer 内部 Worker 状态。
  const sourceKey = useRef(`${filename}:${buffer.byteLength}`).current;
  const errorReported = useRef(false);

  useEffect(() => {
    setReady(false);
    errorReported.current = false;
  }, [sourceKey]);

  const options = useMemo<ViewerOptions>(
    () => ({
      preset: officePreset,
      theme: 'light',
      ...viewerOptions,
    }),
    [viewerOptions],
  );

  return (
    <div className={`relative min-h-0 ${className ?? ''}`}>
      {!ready && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/60">
          <Loader2 className="size-6 animate-spin text-mute" />
          <p className="text-sm text-mute">渲染中…</p>
        </div>
      )}
      <FileViewer
        key={sourceKey}
        ref={ref}
        buffer={buffer}
        filename={filename}
        // 注意:不可传 type(MIME)——core 取扩展名时 type 优先于 filename 且被
        // 当作扩展名,MIME 串会导致"格式不支持"兜底;识别只靠 filename 后缀。
        options={options}
        onEvent={(e) => {
          if (e.type === 'load-complete') {
            setReady(true);
            onReady?.();
          }
        }}
        onStateChange={(state) => {
          if (state.error && !errorReported.current) {
            errorReported.current = true;
            onError?.(state.error instanceof Error ? state.error.message : '文档渲染失败');
          }
        }}
        className="h-full w-full"
      />
    </div>
  );
});

export default ViewerCanvas;
