import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  PROJECTS_ONLY_MINE_COOKIE,
  readProjectsOnlyMine,
  writeProjectsOnlyMine,
} from '@/lib/ui-prefs';

// 「只看我的项目」偏好:cookie 客户端读写。测试环境是 node(无 document),
// 客户端路径用可写的桩 document 模拟 document.cookie 的读写。
describe('ui-prefs:只看我的项目偏好', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubCookie = (cookie: string) => {
    const document = { cookie };
    vi.stubGlobal('document', document);
    return document;
  };

  it('服务端渲染(无 document):读为关,写不抛错', () => {
    expect(readProjectsOnlyMine()).toBe(false);
    expect(() => writeProjectsOnlyMine(true)).not.toThrow();
  });

  it('值为 1 = 开;与其他 cookie 并存时顺序无关', () => {
    stubCookie(`bm-sidebar-collapsed=1; ${PROJECTS_ONLY_MINE_COOKIE}=1; other=x`);
    expect(readProjectsOnlyMine()).toBe(true);
    stubCookie(`${PROJECTS_ONLY_MINE_COOKIE}=1`);
    expect(readProjectsOnlyMine()).toBe(true);
  });

  it('无 cookie、值不为 1、名称仅前缀/后缀相似 = 关(须整段精确匹配)', () => {
    const cookies = [
      '',
      'bm-sidebar-collapsed=1',
      `${PROJECTS_ONLY_MINE_COOKIE}=0`,
      `${PROJECTS_ONLY_MINE_COOKIE}=`,
      `x${PROJECTS_ONLY_MINE_COOKIE}=1`,
      `${PROJECTS_ONLY_MINE_COOKIE}x=1`,
    ];
    for (const cookie of cookies) {
      stubCookie(cookie);
      expect(readProjectsOnlyMine(), cookie).toBe(false);
    }
  });

  it('打开写 1(一年);关闭清 cookie(回到默认)', () => {
    const document = stubCookie('');
    writeProjectsOnlyMine(true);
    expect(document.cookie).toBe(
      `${PROJECTS_ONLY_MINE_COOKIE}=1; path=/; max-age=31536000; samesite=lax`,
    );
    writeProjectsOnlyMine(false);
    expect(document.cookie).toBe(`${PROJECTS_ONLY_MINE_COOKIE}=; path=/; max-age=0; samesite=lax`);
  });
});
