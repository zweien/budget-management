import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // 排除 Python venv(.venv,docx 导出依赖),其符号链接会让 Turbopack 文件追踪失败。
  outputFileTracingExcludes: { '/**': ['.venv/**'] },
  // /changelog 页运行时 fs 读取 CHANGELOG.md:standalone 打包需显式追踪该文件。
  outputFileTracingIncludes: { '/changelog': ['./CHANGELOG.md'] },
};

export default nextConfig;
