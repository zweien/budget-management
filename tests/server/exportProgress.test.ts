import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createExportProgress,
  finishExportProgress,
  getExportProgress,
  updateExportProgress,
} from '@/server/exports/progress';

/** 导出进度注册表:单进程内存实现,TTL/上限/单调百分比语义。 */
describe('exports/progress 注册表', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('create → update → finish(done) 全流程,percent 单调且封顶 100', () => {
    createExportProgress('test-id-0001');
    updateExportProgress('test-id-0001', 30, '读取业务记录（10 条）');
    updateExportProgress('test-id-0001', 55.4, '装配业务明细（2/3 节）');
    // 回退的百分比对调用方容错:取 max,不倒退。
    updateExportProgress('test-id-0001', 40, '乱序回调');
    finishExportProgress('test-id-0001', 'done');

    const entry = getExportProgress('test-id-0001')!;
    expect(entry.status).toBe('done');
    expect(entry.percent).toBe(100);
    expect(entry.phase).toBe('完成');
    expect(entry.error).toBeNull();
  });

  it('finish(error) 保留错误文案,percent 不被置 100', () => {
    createExportProgress('test-id-0002');
    updateExportProgress('test-id-0002', 42, '装配中');
    finishExportProgress('test-id-0002', 'error', '导出行数超过上限');
    const entry = getExportProgress('test-id-0002')!;
    expect(entry.status).toBe('error');
    expect(entry.percent).toBe(42);
    expect(entry.error).toBe('导出行数超过上限');
  });

  it('未知 id 返回 null;过期条目被读取时清除', () => {
    expect(getExportProgress('no-such-id')).toBeNull();
    createExportProgress('test-id-0003');
    updateExportProgress('test-id-0003', 10, '开始');
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(getExportProgress('test-id-0003')).toBeNull();
  });

  it('percent 超出 0-100 被夹取', () => {
    createExportProgress('test-id-0004');
    updateExportProgress('test-id-0004', 120, '超界');
    expect(getExportProgress('test-id-0004')!.percent).toBe(100);
  });
});
