import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // 集成测试共用同一个 PostgreSQL 实例(budget@localhost:5434),
    // 多文件并发会在共享库上互相污染(项目/用户/锁的唯一约束 409)。
    // 串行执行可保证幂等、可复跑;集成测试为 IO 密集,串行开销可接受。
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
