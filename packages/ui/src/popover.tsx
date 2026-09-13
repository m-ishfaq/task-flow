import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

/**
 * `ai/phase-6.5-ui-polish.md` Wave 1's audit found FIVE files hand-rolling
 * `Popover.Content` — `chat-page.tsx` alone has four independent instances
 * (pinned messages, new channel, new DM, and the emoji/reaction picker),
 * plus `notification-bell.tsx`, `card-tile.tsx` (quick-assignee, quick-due-
 * date), `detail/assignee-section.tsx`, and `filter/filter-builder.tsx`. Nine
 * instances across six files, all but one agreeing on
 * `rounded border border-line bg-surface-raised shadow-lg`.
 *
 * The one that didn't — `notification-bell.tsx`'s `rounded-md ... bg-surface`
 * — was drift, not a deliberate choice (nothing in that file's own comments
 * explains a reason it should differ), so the fix folds it back into the
 * shared shell rather than giving the shared component a variant to carry
 * that difference forward.
 */
export interface PopoverContentProps extends Omit<
  ComponentProps<typeof PopoverPrimitive.Content>,
  'className'
> {
  readonly className?: string;
}

export function PopoverContent({
  align = 'center',
  sideOffset = 4,
  className,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          /* `rounded-card` (10px), matching `modal.tsx`'s and
             `dropdown-menu.tsx`'s identical move — one shared radius for
             every raised, floating panel in the app rather than the bare
             `rounded` (4px) this shell (and, transitively, all nine call
             sites the header comment above counts) used to carry. */
          'ui-fade z-50 rounded-card border border-line bg-surface-raised shadow-lg',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
