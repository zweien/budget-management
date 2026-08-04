import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 页头规范:caption-mono 眉题 + display-md 负字距标题 + 右侧操作区。
 * 全站页面统一入口,替代原 antd Typography.Title level=3 模式。
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="space-y-1">
        {eyebrow ? <p className="caption-mono">{eyebrow}</p> : null}
        <h1 className="text-display-md">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
