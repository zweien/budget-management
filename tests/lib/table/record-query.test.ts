import { describe, expect, it } from 'vitest';
import { VALUES_FILTER_NONE } from '@/lib/table/filter-fns';
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

  it('科目筛选参数映射：subject → subjectNames、subjectId → subjectIds；取消全选发空集哨兵', () => {
    const params = buildRecordQuery(
      [
        { id: 'subject', value: ['材料费'] },
        { id: 'subjectId', value: ['uuid-1', 'uuid-2'] },
      ],
      [],
      { projectId: 'project', page: 1, pageSize: 100 },
    );
    expect(params.getAll('subjectNames')).toEqual(['材料费']);
    expect(params.getAll('subjectIds')).toEqual(['uuid-1', 'uuid-2']);

    const cleared = buildRecordQuery([{ id: 'subjectId', value: [] }], [], {
      projectId: 'project',
      page: 1,
      pageSize: 100,
    });
    expect(cleared.getAll('subjectIds')).toEqual([VALUES_FILTER_NONE]);
  });
});
