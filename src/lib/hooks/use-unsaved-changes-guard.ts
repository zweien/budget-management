'use client';

import { useEffect, useState } from 'react';

/**
 * 未保存修改的登记处:同一页面可能有多个使用方(设置页三张卡片各自独立保存),
 * 离开拦截必须是整页一份——每个使用方各挂一个监听器的话,一次导航会连弹多个确认框
 * (stopPropagation 拦不住同一目标上的其他监听器)。
 */
const dirtyTokens = new Set<symbol>();
let consumers = 0;

function hasUnsaved(): boolean {
  return dirtyTokens.size > 0;
}

/** 浏览器关闭/刷新。 */
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (hasUnsaved()) e.preventDefault();
}

/**
 * capture 阶段拦截站内 <a> 点击,管 SPA 客户端导航(项目 Tab/侧边栏等,绕过 beforeunload)。
 * 仅拦站内页面跳转;外链、hash、tel/mailto 等放行。
 */
function onClick(e: MouseEvent): void {
  if (!hasUnsaved()) return;
  const anchor = (e.target as HTMLElement | null)?.closest?.('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href || !href.startsWith('/')) return;
  if (!window.confirm('有未保存的修改,确定要离开吗?离开后将丢失未保存内容。')) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * 声明本组件当前有没有未保存修改。任一使用方处于未保存状态时,关闭/刷新与站内跳转都会先确认,
 * 且一次导航只确认一次。浏览器后退无法可靠拦截,不在覆盖范围内。
 */
export function useUnsavedChangesGuard(dirty: boolean): void {
  // 每个使用方一个稳定令牌:懒初始化,只创建一次,渲染间保持同一引用。
  const [token] = useState(() => Symbol('unsaved'));

  // 全局监听整页只挂一份:首个使用方挂载时安装,最后一个卸载时移除。
  useEffect(() => {
    consumers += 1;
    if (consumers === 1) {
      window.addEventListener('beforeunload', onBeforeUnload);
      document.addEventListener('click', onClick, true);
    }
    return () => {
      consumers -= 1;
      if (consumers === 0) {
        window.removeEventListener('beforeunload', onBeforeUnload);
        document.removeEventListener('click', onClick, true);
        dirtyTokens.clear();
      }
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    dirtyTokens.add(token);
    return () => {
      dirtyTokens.delete(token);
    };
  }, [dirty, token]);
}
