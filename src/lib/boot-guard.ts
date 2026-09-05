import { env } from '@/lib/env';

/**
 * 生产安全红线(仅 Node.js 运行时,由 instrumentation.ts 条件动态加载——
 * 本文件使用 process.exit,不能进 Edge 包):
 * MOCK_AUTH=true 时 x-mock-user-id header 可冒充任意用户——生产误配必须启动即崩,
 * 而不是带着免认证上线。注意 register 抛出的错误会被 Next 吞成日志(unhandledRejection)
 * 而服务照常起,因此失败必须显式 process.exit(1),而不是依赖 throw。
 */
export async function runBootGuard(): Promise<void> {
  try {
    if (env.NODE_ENV === 'production' && env.MOCK_AUTH) {
      console.error(
        '❌ 生产环境禁止 MOCK_AUTH=true(mock 模式下 x-mock-user-id 可冒充任意用户)。' +
          '请设置 MOCK_AUTH=false 并配置 AUTHENTIK_ISSUER / AUTHENTIK_CLIENT_ID / ' +
          'AUTHENTIK_CLIENT_SECRET / AUTH_SECRET / APP_BASE_URL。',
      );
      process.exit(1);
    }
  } catch (e) {
    // env.ts 校验失败(如 SSO 四件套缺失):拒绝启动,避免半瘫痪状态接流量。
    console.error('❌ 环境变量校验失败,服务拒绝启动:', e);
    process.exit(1);
  }
}
