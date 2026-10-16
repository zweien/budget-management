import { describe, expect, it, vi } from 'vitest';
import { withExportSlot } from '@/server/exports/concurrency';

const deferred = () => {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
};

describe('导出并发预算', () => {
  it('大任务按顺序执行，小任务不被大任务队列阻塞', async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = withExportSlot(true, async () => {
      order.push('first');
      await gate.promise;
    });
    const second = withExportSlot(true, async () => {
      order.push('second');
    });
    const third = withExportSlot(true, async () => {
      order.push('third');
    });
    try {
      await withExportSlot(false, async () => {
        order.push('small');
      });
      expect(order).toEqual(['first', 'small']);
    } finally {
      gate.release();
    }
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'small', 'second', 'third']);
  });

  it('排队有硬上限，工作失败也释放名额', async () => {
    const gate = deferred();
    const first = withExportSlot(true, () => gate.promise);
    const waiting = Array.from({ length: 8 }, () => withExportSlot(true, async () => 1));
    try {
      await expect(withExportSlot(true, async () => 1)).rejects.toMatchObject({ status: 429 });
    } finally {
      gate.release();
    }
    await Promise.all([first, ...waiting]);
    await expect(
      withExportSlot(true, async () => {
        throw new Error('generation failed');
      }),
    ).rejects.toThrow('generation failed');
    await expect(withExportSlot(true, async () => 'next')).resolves.toBe('next');
  });

  it('等待超时从队列移除，不泄漏名额或永久悬挂', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const first = withExportSlot(true, () => gate.promise);
    const waiting = withExportSlot(true, async () => 'should not run');
    const assertion = expect(waiting).rejects.toMatchObject({ status: 503 });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      gate.release();
      await first;
      vi.useRealTimers();
    }
    await expect(withExportSlot(true, async () => 'next')).resolves.toBe('next');
  });
});
