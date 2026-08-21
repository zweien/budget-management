'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';

interface CommitOnBlurInputProps extends Omit<
  React.ComponentProps<typeof Input>,
  'value' | 'onChange' | 'onBlur' | 'onFocus'
> {
  /** 受控值(来自父级;未编辑时直接展示,外部变化即时反映)。 */
  value: string;
  /** 失焦且草稿与受控值不同时提交。 */
  onCommit: (value: string) => void;
  /**
   * 输入开始(每次按键)即回调,父级可据此尽早标记表单脏(装离开拦截),
   * 不必等失焦提交——否则聚焦中刷新/关页会静默丢草稿。须传稳定引用。
   */
  onEditStart?: () => void;
}

/**
 * 本地草稿输入框:输入期间只更新组件内部 state,失焦时才 onCommit 提交到父级。
 *
 * 用途:表格类可编辑单元格(如初始预算编制的科目名称/单位)。父级受控值经
 * 行数据 → 树构建 → 行模型多层往返,每次按键重建整表会打断中文 IME 组词
 * (输一字即跳出输入)。本地草稿把按键期完全隔离在组件内(零父级重渲染),
 * IME 安全;失焦一次性提交(TanStack 官方 editable-data 模式)。
 *
 * 显示值为 `draft ?? value` 派生:未编辑(draft=null)时直接展示外部值,
 * 保存后重载/表单重置等外部变化即时反映,无需 effect 同步。
 */
export function CommitOnBlurInput({
  value,
  onCommit,
  onEditStart,
  ...rest
}: CommitOnBlurInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);

  return (
    <Input
      {...rest}
      value={draft ?? value}
      onChange={(e) => {
        onEditStart?.();
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
    />
  );
}
