'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

/**
 * 路由段错误兜底:DB 抖动等运行期异常不再落到 Next 默认白页。
 * 服务端细节不进客户端;reset 供用户恢复后重试。
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[page-error]', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-xl font-semibold text-foreground">页面出错了</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        发生了意外错误,请稍后重试;若持续出现请联系管理员
        {error.digest ? (
          <>
            (追踪码 <code className="font-mono">{error.digest}</code>)
          </>
        ) : null}
        。
      </p>
      <Button onClick={reset}>重试</Button>
    </div>
  );
}
