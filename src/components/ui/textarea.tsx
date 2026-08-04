import * as React from 'react';

import { cn } from '@/lib/utils';

/** 原生受控 textarea——历史中文输入法问题的根治形态,不封装额外状态。 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full rounded-md border border-input bg-card px-2.5 py-2 text-sm shadow-l1 transition-colors outline-none',
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

export { Textarea };
