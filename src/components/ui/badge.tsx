import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * DESIGN.md badge-secondary 比例尺(full 圆角 + caption 12px)。
 * 状态语义色遵循 DESIGN.md:success 即 link 蓝、warning 琥珀、error 红。
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs leading-4 whitespace-nowrap transition-colors [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-muted-foreground',
        success: 'bg-success-soft text-link',
        warning: 'bg-warning-soft text-warning-deep',
        error: 'bg-error-soft text-error-deep',
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
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
