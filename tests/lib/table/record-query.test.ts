import { describe, expect, it } from 'vitest';
import { buildRecordQuery } from '@/lib/table/record-query';

describe('记录页服务端查询协议', () => {
  it('项目页清除状态筛选包含作废，录入时间按项目页显示字段查询', () => {
    const params = buildRecordQuery([], [], { projectId: 'project', page: 1, pageSize: 100 });
    expect(params.get('includeVoid')).toBe('1');
    expect(params.get('entryTimeField')).toBe('enteredAt');
  });

  it('明确选择有效状态仍排除作废；全局页保持原来的缺省口径', () => {
    const params = buildRecordQuery([{ id: 'status', value: ['PAID'] }], [], {
      projectId: 'project',
      page: 1,
      pageSize: 100,
    });
    expect(params.has('includeVoid')).toBe(false);
    const global = buildRecordQuery([], [], { page: 1, pageSize: 100 });
    expect(global.has('includeVoid')).toBe(false);
    expect(global.has('entryTimeField')).toBe(false);
  });
});
