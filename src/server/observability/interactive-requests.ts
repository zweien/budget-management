interface InteractiveActivity {
  active: number;
  lastFinished: number;
}
const processState = globalThis as unknown as { budgetInteractiveActivity?: InteractiveActivity };
const activity = (processState.budgetInteractiveActivity ??= { active: 0, lastFinished: 0 });

/** 普通API的在途计数；大文件及导入执行不把自己算作需要优先服务的请求。 */
export function beginInteractiveRequest(path: string, method: string): () => void {
  const heavy =
    path === '/api/statistics/export' ||
    /\/attachments\/(export|package)$/.test(path) ||
    (method === 'POST' &&
      (path === '/api/imports/settlement' || /\/imports(?:\/[^/]+\/confirm)?$/.test(path)));
  if (heavy) return () => {};
  activity.active++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activity.active--;
    activity.lastFinished = performance.now();
  };
}

/** 大附件每段读取等40ms安静窗口，最多让行1秒，持续交互下也能推进。 */
export async function yieldToInteractiveRequests(): Promise<void> {
  const started = performance.now();
  for (;;) {
    const now = performance.now();
    if (
      now - started >= 1000 ||
      (activity.active === 0 && now - Math.max(started, activity.lastFinished) >= 40)
    )
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
