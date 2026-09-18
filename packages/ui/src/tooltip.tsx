import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

/**
 * Tooltip — the one genuinely new primitive added by the warm-dark rebuild
 * (ai/design-rebuild-warm-dark.md §3). The pattern recurs unstyled/ad-hoc in
 * 10+ files; this gives the app a single, consistent tooltip with the warm-
 * dark surface palette baked in.
 *
 * Styled to match PopoverContent's visual language (surface-raised, border,
 * shadow) at a smaller, lighter weight appropriate for transient hints.
 */
export interface TooltipContentProps extends Omit<
  ComponentProps<typeof TooltipPrimitive.Content>,
  'className'
> {
  readonly className?: string;
}

export function TooltipContent({ sideOffset = 4, className, ...props }: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'ui-fade z-50 max-w-xs rounded-md border border-line bg-surface-raised px-3 py-1.5 text-[12px] leading-relaxed text-ink shadow-md',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
