'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';

/** 异步写入完成后使用当前页/筛选闭包，避免写入前的回调把旧页重新拉回来。 */
export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => latest.current(...args), []);
}
