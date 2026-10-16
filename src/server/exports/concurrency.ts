import { HTTPError } from '@/lib/auth/session';

interface Waiter {
  resume: () => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ExportSlots {
  active: boolean;
  waiting: Waiter[];
}

// 同一进程的两种附件打包及Excel共用预算，热加载/路由模块不各自建队列。
const processState = globalThis as unknown as { budgetExportSlots?: ExportSlots };
const slots = (processState.budgetExportSlots ??= { active: false, waiting: [] });

/** 大文件一次执行一个，最多排8个、等待30秒；小文件直接执行。 */
export async function withExportSlot<T>(large: boolean, work: () => Promise<T>): Promise<T> {
  if (!large) return work();
  if (slots.active) {
    if (slots.waiting.length >= 8) throw new HTTPError(429, '导出任务较多，请稍后重试');
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resume: resolve,
        timer: setTimeout(() => {
          const index = slots.waiting.indexOf(waiter);
          if (index >= 0) slots.waiting.splice(index, 1);
          reject(new HTTPError(503, '导出排队等待超时，请稍后重试'));
        }, 30_000),
      };
      slots.waiting.push(waiter);
    });
  } else slots.active = true;
  try {
    return await work();
  } finally {
    const next = slots.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resume();
    } else slots.active = false;
  }
}
