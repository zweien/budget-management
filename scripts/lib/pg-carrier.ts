/**
 * pg 客户端工具(pg_dump / pg_restore / psql)的执行载体探测与封装。
 *
 * 本机通常不装 postgresql-client;数据库跑在 docker compose(postgres:16-alpine)里。
 * 按 ADR 0003 的探测顺序自动选择载体:
 *   1. compose —— `docker compose exec -T postgres <tool>`(容器内经 unix socket 连本库;
 *      仅在未显式覆盖 --url 时使用,因为 socket 连接的就是 compose 自己的库);
 *   2. docker  —— `docker run --rm --network host -i postgres:16-alpine <tool>`(经完整
 *      DATABASE_URL 直连,--network host 使容器可达宿主回环与内网 PG;Linux 部署);
 *   3. local   —— PATH 上的本机 <tool>(需自装 postgresql-client-16)。
 *
 * 连接参数拼接:pg_restore 必须用 `-d <connstr>`(不接受位置参数 connstr),
 * 其余工具(pg_dump/psql)在末尾追加位置 connstr;compose 载体改用 `-U <user> -d <db>`。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';

/** scripts/lib → 仓库根(compose 文件所在)。 */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const PG_IMAGE = 'postgres:16-alpine';

export type PgTool = 'pg_dump' | 'pg_restore' | 'psql';

export interface ParsedDbUrl {
  user: string;
  password: string | null;
  host: string;
  port: string;
  database: string;
}

/** 解析 postgresql:// 连接串(仅取连接要素,查询参数忽略)。纯函数,便于单测。 */
export function parseDbUrl(url: string): ParsedDbUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL 不是合法连接串: ${url}`);
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    throw new Error(`DATABASE_URL 协议应为 postgresql:// : ${url}`);
  }
  const database = u.pathname.replace(/^\//, '');
  if (!u.username || !database) {
    throw new Error(`DATABASE_URL 缺少用户名或库名: ${url}`);
  }
  return {
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : null,
    host: u.hostname,
    port: u.port || '5432',
    database,
  };
}

export type PgCarrier = 'compose' | 'docker' | 'local';

function probeCompose(): boolean {
  const r = spawnSync('docker', ['compose', 'ps', '-q', 'postgres'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0 && !!r.stdout.trim();
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** 通配发布(绑全部网卡):URL 为回环地址即可达;非回环 URL 视为目标不明,不匹配。 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * compose 载体的目标校验:仅当 URL 的 host:port 与 compose 发布端口一致时才可用,
 * 防止「DATABASE_URL 指向外部库而本机 compose 在跑」时静默 dump 本地同名库。
 */
function composeTargetMatchesUrl(url: string): boolean {
  const r = spawnSync('docker', ['compose', 'port', 'postgres', '5432'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout.trim()) return false;
  const m = /^(.+):(\d+)$/.exec(r.stdout.trim().split('\n')[0].trim());
  if (!m) return false;
  const [, publishedHost, publishedPort] = m;
  const parsed = parseDbUrl(url);
  const sameHost =
    publishedHost === parsed.host ||
    (WILDCARD_HOSTS.has(publishedHost) && LOOPBACK_HOSTS.has(parsed.host)) ||
    (LOOPBACK_HOSTS.has(publishedHost) && LOOPBACK_HOSTS.has(parsed.host));
  return sameHost && publishedPort === parsed.port;
}

/** Prisma 专用连接参数(pg_dump/pg_restore/psql 的 libpq 不认识,传了直接报错)。 */
const PRISMA_ONLY_PARAMS = new Set([
  'schema',
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
]);

/** 剥离 Prisma 专用参数后的连接串,供 docker/local 载体直连(其余参数如 sslmode 保留)。 */
export function normalizeUrlForPgTools(url: string): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (PRISMA_ONLY_PARAMS.has(key)) u.searchParams.delete(key);
  }
  return u.toString().replace(/\?$/, '');
}

function probeDocker(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  return r.status === 0 && !!r.stdout.trim();
}

function probeLocal(tool: PgTool): boolean {
  const r = spawnSync(tool, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

/**
 * 探测可用的最小载体(探测顺序即优先级)。allowCompose=false 时跳过 compose
 * (显式 --url 覆盖目标库的场景,socket 连不上别处的库);即便允许,compose 载体
 * 也要求 URL 与 compose 发布端口一致(见 composeTargetMatchesUrl)。
 */
export function detectCarrier(opts: {
  tool: PgTool;
  url: string;
  allowCompose?: boolean;
}): PgCarrier | null {
  if (opts.allowCompose !== false && probeCompose() && composeTargetMatchesUrl(opts.url))
    return 'compose';
  if (probeDocker()) return 'docker';
  if (probeLocal(opts.tool)) return 'local';
  return null;
}

/** 各载体下 <tool> 的完整命令行(不含连接串的 args 由调用方给出)。 */
function buildCommand(
  carrier: PgCarrier,
  tool: PgTool,
  args: string[],
  url: string,
): { cmd: string; argv: string[]; cwd?: string } {
  if (carrier === 'compose') {
    const { user, database } = parseDbUrl(url);
    // 容器内 socket 连接:忽略 URL 的 host/port(映射端口在容器内不存在)。
    return {
      cmd: 'docker',
      argv: ['compose', 'exec', '-T', 'postgres', tool, '-U', user, '-d', database, ...args],
      cwd: REPO_ROOT,
    };
  }
  // docker/local:经完整 URL 直连(剥掉 Prisma 专用参数)。
  // pg_restore 只认 -d connstr,其余工具末尾追加位置 connstr。
  const connUrl = normalizeUrlForPgTools(url);
  const connArgs = tool === 'pg_restore' ? [...args, '-d', connUrl] : [...args, connUrl];
  if (carrier === 'docker') {
    return {
      cmd: 'docker',
      argv: ['run', '--rm', '--network', 'host', '-i', PG_IMAGE, tool, ...connArgs],
    };
  }
  return { cmd: tool, argv: connArgs };
}

export interface RunPgToolOptions {
  /** 目标库连接串。 */
  url: string;
  /** 工具标准输入的来源文件(pg_restore 导入 dump 用);与 stdin 二选一。 */
  inputFile?: string;
  /** 工具标准输入(字符串)。 */
  stdin?: string;
  /** 工具标准输出的落盘文件(pg_dump 导出用);缺省收集为字符串返回。 */
  stdoutFile?: string;
  /** 是否允许 compose 载体(默认允许,但仍要求 URL 与 compose 发布端口一致)。 */
  allowCompose?: boolean;
}

export interface RunPgToolResult {
  carrier: PgCarrier;
  /** 未指定 stdoutFile 时的标准输出内容。 */
  stdout: string | null;
}

/** 执行 pg 工具;非零退出码抛错(附 stderr 摘要)。 */
export async function runPgTool(
  tool: PgTool,
  args: string[],
  opts: RunPgToolOptions,
): Promise<RunPgToolResult> {
  const carrier = detectCarrier({ tool, url: opts.url, allowCompose: opts.allowCompose });
  if (!carrier) {
    throw new Error(
      `找不到可用的 pg 工具载体(需要 docker compose / docker / 本机 ${tool} 之一)。` +
        `本机可安装 postgresql-client-16,或确认 docker 可用。`,
    );
  }
  const { cmd, argv, cwd } = buildCommand(carrier, tool, args, opts.url);

  const child: ChildProcessWithoutNullStreams = spawn(cmd, argv, { cwd });

  let stdout: string | null = null;
  let stdoutErr: unknown = null;
  if (opts.stdoutFile) {
    const out = createWriteStream(opts.stdoutFile, { mode: 0o600 });
    child.stdout.pipe(out);
    out.on('error', (e) => (stdoutErr = e));
  } else {
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stdout.on('end', () => (stdout = Buffer.concat(chunks).toString('utf8')));
  }
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  if (opts.inputFile) {
    const input = createReadStream(opts.inputFile);
    input.on('error', () => child.kill('SIGKILL'));
    input.pipe(child.stdin);
  } else if (opts.stdin !== undefined) {
    child.stdin.end(opts.stdin);
  } else {
    child.stdin.end();
  }

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? -1));
  });
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  if (stdoutErr) throw stdoutErr;
  if (code !== 0) {
    throw new Error(`${tool} 退出码 ${code}(载体: ${carrier})\n${stderr.slice(0, 4000)}`);
  }
  return { carrier, stdout };
}

/**
 * 在 URL 指向的 PostgreSQL 实例上执行 SQL(psql 便捷封装)。
 * CREATE/DROP DATABASE 不能在事务里跑,psql -c 天然满足。
 */
export async function runSql(sql: string, opts: { url: string; allowCompose?: boolean }) {
  return runPgTool('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql], {
    url: opts.url,
    allowCompose: opts.allowCompose,
  });
}

/** 校验 identifier 合法(库名等拼进 SQL 前的防注入)。 */
export function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }
}

/** 经 psql 在目标实例上创建/删除临时数据库(测试与演练用)。 */
export async function createScratchDb(name: string, opts: { url: string }): Promise<string> {
  assertSafeIdentifier(name);
  await runSql(`CREATE DATABASE "${name}"`, opts);
  const parsed = parseDbUrl(opts.url);
  return `postgresql://${parsed.user}:${encodeURIComponent(parsed.password ?? '')}@${parsed.host}:${parsed.port}/${name}`;
}

export async function dropScratchDb(name: string, opts: { url: string }): Promise<void> {
  assertSafeIdentifier(name);
  await runSql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, opts);
}
