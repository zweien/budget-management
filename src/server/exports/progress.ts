import { HTTPError } from '@/lib/auth/session';

/**
 * 导出进度注册表(进程内):长耗时导出(经费报告 Word 等)按随机 id 记录
 * 阶段/百分比,前端轮询展示。单进程部署(pm2 fork / 单容器)下够用;
 * 条目 10 分钟过期、总量硬上限 200,写入时顺带清理,不设定时器。
 *
 * 状态机:running → done | error 单向、终态不可变(旧请求迟到回调不会把
 * error 洗成 done)。id 由客户端生成(crypto.randomUUID)仅作 key;值不含
 * 任何业务数据(只有阶段文案/数字/白名单化错误文案),轮询端点仍走 requireUser。
 */

export interface ExportProgress {
  /** 展示给用户的阶段文案,如「读取业务记录」。 */
  phase: string;
  /** 0-100 整数。 */
  percent: number;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  updatedAt: number;
  error: string | null;
}

const MAX_ENTRIES = 200;
const TTL_MS = 10 * 60 * 1000;

interface ProgressState {
  entries: Map<string, ExportProgress>;
}

// 同一进程复用(热加载/路由模块不各自建表,与 exports/concurrency 同款挂载)。
const processState = globalThis as unknown as { budgetExportProgress?: ProgressState };
const state = (processState.budgetExportProgress ??= { entries: new Map() });

/** 过期条目清除(TTL)。 */
function pruneExpired(now = Date.now()): void {
  for (const [id, entry] of state.entries) {
    if (now - entry.updatedAt > TTL_MS) state.entries.delete(id);
  }
}

/** 容量淘汰:按更新时间淘汰最旧,直至不超过硬上限。 */
function evictOldest(): void {
  while (state.entries.size > MAX_ENTRIES) {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, entry] of state.entries) {
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    state.entries.delete(oldestId);
  }
}

export function createExportProgress(id: string): void {
  pruneExpired();
  const now = Date.now();
  state.entries.set(id, {
    phase: '准备中',
    percent: 0,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    error: null,
  });
  evictOldest();
}

/** 仅 running 态可推进;终态忽略(幂等,防迟到回调改写)。 */
export function updateExportProgress(id: string, percent: number, phase: string): void {
  const entry = state.entries.get(id);
  if (!entry || entry.status !== 'running') return;
  entry.percent = Math.max(entry.percent, Math.min(100, Math.round(percent)));
  entry.phase = phase;
  entry.updatedAt = Date.now();
}

/** 仅允许 running → done|error 一次落定;终态再调用为 no-op(error 不被 done 洗掉)。 */
export function finishExportProgress(id: string, status: 'done' | 'error', error?: string): void {
  const entry = state.entries.get(id);
  if (!entry || entry.status !== 'running') return;
  entry.status = status;
  entry.error = error ?? null;
  if (status === 'done') {
    entry.percent = 100;
    entry.phase = '完成';
  }
  entry.updatedAt = Date.now();
}

export function getExportProgress(id: string): ExportProgress | null {
  const entry = state.entries.get(id);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TTL_MS) {
    state.entries.delete(id);
    return null;
  }
  return { ...entry };
}

/**
 * 进度端点可公开的错误文案:业务 HTTPError(参数校验/413 上限等)消息本身
 * 面向用户,保留原文;未知异常(Prisma/IO/第三方库)可能带内部路径或实现细节,
 * 折叠为通用文案,与 withRoute 的未知异常收敛口径一致。
 */
export function publicProgressError(error: unknown): string {
  if (error instanceof HTTPError) return error.message;
  return '生成失败，请重试';
}
