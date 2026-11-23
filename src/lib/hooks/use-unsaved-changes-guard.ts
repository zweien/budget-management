'use client';

import { useEffect } from 'react';

/**
 * 脏状态离开拦截:beforeunload 管浏览器关闭/刷新;
 * capture 阶段拦截站内 <a> 点击,管 SPA 客户端导航(项目 Tab/侧边栏等,绕过 beforeunload)。
 * 浏览器后退无法可靠拦截,不在覆盖范围内。
 */
export function useUnsavedChangesGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      // 仅拦站内页面跳转;外链、hash、tel/mailto 等放行。
      if (!href || !href.startsWith('/')) return;
      if (!window.confirm('有未保存的修改,确定要离开吗?离开后将丢失未保存内容。')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}
