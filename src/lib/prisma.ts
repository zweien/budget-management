import { PrismaClient } from '@prisma/client';
import { env } from '@/lib/env';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * 连接池上限基线:拼进 DATABASE_URL 的 connection_limit(URL 已带该参数时不覆盖,
 * 交给部署方自行调优)。Prisma 默认 ≈CPU×2+1,小型部署并发(首页聚合/审批)易打满。
 */
function datasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('connection_limit=')) return undefined;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=${env.DB_CONNECTION_LIMIT}`;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    datasourceUrl: datasourceUrl(),
    // 交互事务超时基线:库默认 5s 对批量写入(导入确认/审批落预算)过紧,
    // 会以 P2028 整批回滚。单笔交互仍远小于该上限;超大批次应在调用方分批。
    transactionOptions: { maxWait: 5_000, timeout: 30_000 },
  });

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
