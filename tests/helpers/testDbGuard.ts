import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 测试库守卫:集成测试会往库里建用户、项目、凭证与审计日志,绝不能连到生产库。
 *
 * 判定依据是「本检出目录是不是生产运行目录」:`.env.production` 被 .gitignore 忽略,
 * 只存在于真实部署主机上,其 DATABASE_URL 即该主机的生产库。CI 与隔离验证副本都没有这个
 * 文件,不受影响。背景:2026-11-17~21 期间本仓库的生产运行目录里直接跑过 19 轮测试,
 * 在生产库留下 76 个夹具账号与 19 把凭证(2026-11-28 清理)。
 */

/** 回环地址的各种写法归一(同一台机器上的同一个库不因 localhost / 127.0.0.1 写法不同而漏判)。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** 从 env 文件文本里取某个键的值(去单/双引号);取不到返回 null。 */
export function readEnvValue(envFileText: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\s*(?:export\\s+)?${escaped}=("([^"]*)"|'([^']*)'|[^\\s#]+)`, 'm').exec(
    envFileText,
  );
  if (!m) return null;
  return m[2] ?? m[3] ?? m[1];
}

/**
 * 连接串的「库身份」:协议 + 主机 + 端口 + 库名(忽略账号、口令与查询参数)。
 * 非 postgres 连接串或非法值返回 null。
 */
export function databaseIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return null;
  const rawHost = u.hostname.toLowerCase();
  const host = LOOPBACK_HOSTS.has(rawHost) ? 'localhost' : rawHost;
  return `${u.protocol}//${host}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`;
}

export interface TestDbGuardInput {
  /** 测试将要运行的目录(仓库根)。 */
  dir: string;
  /** 测试进程拿到的 DATABASE_URL(须由调用方显式提供)。 */
  databaseUrl: string | undefined;
}

/**
 * 能否在该目录跑测试:返回拒绝原因,null = 放行。
 * - 目录里没有 `.env.production`:普通开发检出 / CI / 隔离副本,不做限制。
 * - 有(即生产运行目录):DATABASE_URL 必须已显式设置,且不得指向 `.env.production` 的库;
 *   读不到 `.env.production` 无法核对时同样拒绝。
 */
export function testDbGuardReason({ dir, databaseUrl }: TestDbGuardInput): string | null {
  const productionEnvPath = path.join(dir, '.env.production');
  let productionEnvText: string;
  try {
    productionEnvText = readFileSync(productionEnvPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `无法读取 ${productionEnvPath} 以核对生产库(${(e as Error).message})。`;
  }
  if (!databaseUrl) {
    return '本目录存在 .env.production,即生产运行目录,但未显式设置 DATABASE_URL。';
  }
  // 连接串含口令,拒绝原因里不回显原值。
  const target = databaseIdentity(databaseUrl);
  if (!target) {
    return 'DATABASE_URL 不是合法的 postgres 连接串,无法确认不是生产库。';
  }
  const productionDb = databaseIdentity(readEnvValue(productionEnvText, 'DATABASE_URL'));
  if (productionDb && target === productionDb) {
    return `DATABASE_URL 指向本目录 .env.production 的生产库(${target})。`;
  }
  return null;
}

/** 配置加载期调用:不允许时抛错,测试进程直接拒绝启动。 */
export function assertTestsAllowedIn(dir: string, databaseUrl: string | undefined): void {
  const reason = testDbGuardReason({ dir, databaseUrl });
  if (!reason) return;
  throw new Error(
    [
      `拒绝运行测试:${reason}`,
      '集成测试会建用户/项目/凭证/审计日志,不能对着生产库跑。',
      '请按 CLAUDE.md「隔离验证的做法」:另起一次性 Postgres(--tmpfs、只绑 127.0.0.1),',
      '显式把 DATABASE_URL 指过去,并在隔离副本里执行。',
    ].join('\n'),
  );
}
