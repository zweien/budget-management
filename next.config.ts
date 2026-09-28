import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 固定 workspace root:家目录存在无关 package-lock.json 时,Next 会误判
  // /home/z 为根,导致 React Client Manifest 路径错乱("Could not find the module
  // ... in the React Client Manifest")。next dev/build 从项目根启动,cwd 即本项目。
  turbopack: {
    root: process.cwd(),
  },
  output: 'standalone',
  // 不对外泄露框架版本指纹(安全加固基线)。
  poweredByHeader: false,
  // 安全响应头基线(审计 Web 姿态硬化项):禁止跨站嵌套、禁 MIME 嗅探、
  // 收敛 Referer 泄露。完整的 CSP 策略另行评估后加入(见 docs/security-audit-run1-checklist.md)。
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  // 排除 Python venv(.venv,docx 导出依赖),其符号链接会让 Turbopack 文件追踪失败。
  outputFileTracingExcludes: { '/**': ['.venv/**'] },
  // /changelog 页运行时 fs 读取 CHANGELOG.md:standalone 打包需显式追踪该文件。
  outputFileTracingIncludes: { '/changelog': ['./CHANGELOG.md'] },
  // dev 模式的 DNS rebinding 防护:局域网 IP 访问时,HMR websocket 与资源请求
  // 默认被跨域拦截,须在此声明允许的来源。本机 IP 变更时同步改。
  allowedDevOrigins: ['192.168.5.6'],
};

export default nextConfig;
