/**
 * 运行时启动校验入口(仅 server 启动时执行一次,不参与 next build)。
 * env.ts 在构建期也会被加载(next build 加载路由模块),所以含 process.exit 的
 * 校验体拆到 boot-guard 并按 NEXT_RUNTIME 条件动态加载——Edge 包不分析 Node API。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runBootGuard } = await import('@/lib/boot-guard');
  await runBootGuard();
}
