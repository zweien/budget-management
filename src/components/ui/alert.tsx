import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/** DESIGN.md 语义色 soft 底 + deep 字;图标与内容基线对齐。 */
const alertVariants = cva('relative grid gap-1 rounded-lg border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-border bg-card text-card-foreground',
      info: 'border-link/30 bg-success-soft text-link-deep',
      success: 'border-link/30 bg-success-soft text-link-deep',
      warning: 'border-warning/40 bg-warning-soft text-warning-deep',
      error: 'border-destructive/30 bg-error-soft text-error-deep',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('font-medium tracking-[-0.14px]', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="alert-description" className={cn('text-sm opacity-90', className)} {...props} />
  );
}

export { Alert, AlertTitle, AlertDescription };
