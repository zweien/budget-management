import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/** IDRL 横幅规格:状态基色 5% 混 surface 底 + 30% 边界 + *Text 文字。 */
const alertVariants = cva('relative grid gap-1 rounded-lg border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-border bg-card text-card-foreground',
      info: 'border-primary/30 bg-[color-mix(in_srgb,var(--primary)_5%,var(--surface))] text-primary-text',
      success:
        'border-success/30 bg-[color-mix(in_srgb,var(--success)_5%,var(--surface))] text-success',
      warning:
        'border-warning/40 bg-[color-mix(in_srgb,var(--warning)_5%,var(--surface))] text-warning-deep',
      error:
        'border-destructive/30 bg-[color-mix(in_srgb,var(--destructive)_5%,var(--surface))] text-error-deep',
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
      className={cn('font-bold tracking-[-0.025em]', className)}
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
