import * as React from 'react';

import { cn } from '@/lib/utils';

/** DESIGN.md form-input-sm 规格:32px 高、6px 圆角、hairline 边框。 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-8 w-full min-w-0 rounded-md border border-input bg-card px-2.5 py-1 text-sm shadow-l1 transition-colors outline-none',
        'placeholder:text-mute',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
