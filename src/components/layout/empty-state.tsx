import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * DESIGN.md ex-empty-state-card:soft 面 + 宽松内边距 + 引导动作。
 * 用于列表/表格无数据场景。
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg bg-muted/60 px-6 py-16 text-center',
        className,
      )}
    >
      {icon ? <div className="text-mute [&_svg]:size-8">{icon}</div> : null}
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description ? <p className="text-xs text-mute">{description}</p> : null}
      {action}
    </div>
  );
}
