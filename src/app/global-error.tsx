'use client';

/**
 * 根布局错误兜底(error.tsx 之上最后一道):layout 本身崩溃时的极简壳。
 * 必须自带 <html>/<body>,不依赖任何布局/样式 token。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          margin: 0,
        }}
      >
        <h2 style={{ fontSize: 20, margin: 0 }}>系统出错了</h2>
        <p style={{ color: '#64748b', fontSize: 14 }}>
          发生了意外错误,请刷新页面重试
          {error.digest ? `(追踪码 ${error.digest})` : ''}。
        </p>
        <button
          onClick={reset}
          style={{
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid #cbd5e1',
            background: '#0f172a',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </body>
    </html>
  );
}
