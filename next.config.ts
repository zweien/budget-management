import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // 排除 Python venv(.venv,docx 导出依赖),其符号链接会让 Turbopack 文件追踪失败。
  outputFileTracingExcludes: { '/**': ['.venv/**'] },
};

export default nextConfig;
