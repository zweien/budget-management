'use client';

/**
 * 文本复制(诚实版)。
 *
 * - 安全上下文(https/localhost):Async Clipboard API,成功即真复制。
 * - 非安全上下文(http 局域网):无 Clipboard API;execCommand('copy') 在
 *   Dialog 焦点陷阱下会「返回 true 但剪贴板为空」的假成功(实测),因此
 *   不再使用——改为选中页面上 [data-copy-text] 可见明文并返回 'manual',
 *   由 UI 提示用户按 Ctrl+C(浏览器原生复制选区,任何焦点陷阱都拦不住)。
 *
 * 返回:'copied'(已进剪贴板)| 'manual'(已全选明文,需提示用户 Ctrl+C)。
 */
export type CopyResult = 'copied' | 'manual';

export async function copyTextToClipboard(text: string): Promise<CopyResult> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      /* 权限被拒等:落入手动选中 */
    }
  }
  const el = document.querySelector<HTMLElement>('[data-copy-text]');
  if (el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  return 'manual';
}
