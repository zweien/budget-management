import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * IDRL 徽章:圆点 + 文字(颜色必须配文字,圆点用 currentColor)、5px 圆角、
 * 4px/7px 内距、12px/1.5;底色为状态基色 15% 混入 surface。
 * 状态语义遵循 IDRL:success 绿 / warning 琥珀 / destructive 红 / info 品牌蓝。
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-[5px] border border-transparent px-[7px] py-1 text-xs leading-[18px] whitespace-nowrap transition-colors [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary-soft text-primary-text',
        secondary: 'bg-secondary text-muted-foreground',
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning',
        error: 'bg-error-soft text-error-deep',
        info: 'bg-primary-soft text-primary-text',
        outline: 'border-border text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}>
      <span aria-hidden="true" className="size-[5px] shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
