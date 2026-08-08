import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

/**
 * `ai/phase-6.5-ui-polish.md` Wave 1's audit: `shell.tsx`'s org switcher and
 * account menu, and `card-tile.tsx`'s overflow menu, each built their own
 * `Content`/`Item`/`Separator` styling independently — three real instances of
 * the same `rounded border border-line bg-surface-raised p-1 shadow-lg` shell
 * and the same `data-[highlighted]:bg-surface-hover` item state, which is the
 * threshold PLAN.md §6 sets for extracting a component rather than living with
 * a fourth copy the next menu would have added.
 */
export const DropdownMenuRoot = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export interface DropdownMenuContentProps extends Omit<
  ComponentProps<typeof DropdownMenuPrimitive.Content>,
  'className'
> {
  readonly className?: string;
}

export function DropdownMenuContent({
  sideOffset = 4,
  className,
  ...props
}: DropdownMenuContentProps) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'min-w-40 rounded border border-line bg-surface-raised p-1 shadow-lg',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

type DropdownMenuItemTone = 'default' | 'muted';

const ITEM_TONE: Readonly<Record<DropdownMenuItemTone, string>> = {
  /* shell.tsx's own menu items, card-tile.tsx's "Archive" */
  default: 'text-ink',
  /* shell.tsx's "All organizations…" and the signed-in email row */
  muted: 'text-ink-muted',
};

export interface DropdownMenuItemProps extends Omit<
  ComponentProps<typeof DropdownMenuPrimitive.Item>,
  'className'
> {
  readonly tone?: DropdownMenuItemTone;
  readonly className?: string;
}

export function DropdownMenuItem({ tone = 'default', className, ...props }: DropdownMenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-sm outline-none',
        'data-[highlighted]:bg-surface-hover',
        ITEM_TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator className={cn('my-1 h-px bg-line', className)} {...props} />
  );
}
