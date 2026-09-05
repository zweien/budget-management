/**
 * 运行时启动校验(仅 server 启动时执行一次,不参与 next build)。
 * env.ts 在构建期也会被加载(next build 加载路由模块),所以生产安全红线放这里。
 * 注意:register 抛出的错误会被 Next 吞成日志(unhandledRejection)而服务照常起,
 * 因此失败必须显式 process.exit(1),而不是依赖 throw。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { env } = await import('@/lib/env');
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
