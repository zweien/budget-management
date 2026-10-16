import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestMetrics {
  dbOperations: number;
  /** Prisma 调用耗时之和，含连接等待；并行调用会重叠，不等于请求关键路径。 */
  dbDurationMs: number;
  authDurationMs: number;
}

export const requestMetrics = new AsyncLocalStorage<RequestMetrics>();

/** 不记录 SQL、参数或身份，只累计当前请求的数据库操作耗时。 */
export async function measureDatabase<T>(operation: () => Promise<T>): Promise<T> {
  const metrics = requestMetrics.getStore();
  if (!metrics) return operation();
  const start = performance.now();
  metrics.dbOperations++;
  try {
    return await operation();
  } finally {
    metrics.dbDurationMs += performance.now() - start;
  }
}

export async function measureAuthentication<T>(operation: () => Promise<T>): Promise<T> {
  const metrics = requestMetrics.getStore();
  if (!metrics) return operation();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    metrics.authDurationMs += performance.now() - start;
  }
}
