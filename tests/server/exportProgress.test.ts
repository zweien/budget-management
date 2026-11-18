import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { HTTPError } from '@/lib/auth/session';
import {
  createExportProgress,
  finishExportProgress,
  getExportProgress,
  publicProgressError,
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

  it('终态不可变:error 落定后 update 无效,迟到的 finish(done) 不能洗成成功', () => {
    createExportProgress('test-id-0005');
    updateExportProgress('test-id-0005', 60, '装配中');
    finishExportProgress('test-id-0005', 'error', '导出行数超过上限');
    // 终态后的迟到进度回调:忽略。
    updateExportProgress('test-id-0005', 90, '迟到的进度');
    // 旧请求迟到的成功落定:不得覆盖 error。
    finishExportProgress('test-id-0005', 'done');
    const entry = getExportProgress('test-id-0005')!;
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('导出行数超过上限');
    expect(entry.percent).toBe(60);
    expect(entry.phase).toBe('装配中');
  });

  it('publicProgressError:HTTPError 保留业务文案,未知异常折叠为通用文案', () => {
    expect(publicProgressError(new HTTPError(413, '导出行数超过上限 100000'))).toBe(
      '导出行数超过上限 100000',
    );
    expect(
      publicProgressError(new Error('PrismaClientInitializationError: ECONNREFUSED 10.0.0.3:5432')),
    ).toBe('生成失败，请重试');
    expect(publicProgressError('字符串异常')).toBe('生成失败，请重试');
  });

  it('容量硬上限 200:第 201 个写入后最旧条目被淘汰', () => {
    for (let i = 0; i < 201; i += 1) {
      vi.setSystemTime(Date.now() + 1); // updatedAt 单调,淘汰序确定
      createExportProgress(`cap-id-${String(i).padStart(3, '0')}`);
    }
    expect(getExportProgress('cap-id-000')).toBeNull(); // 201 个 → 最旧 1 个被淘汰
    expect(getExportProgress('cap-id-001')).not.toBeNull();
    expect(getExportProgress('cap-id-200')).not.toBeNull();
  });
});
