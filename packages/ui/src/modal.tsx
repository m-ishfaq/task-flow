import * as Dialog from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

/**
 * A centred (or top-anchored) dialog, styled once instead of seven times.
 *
 * `ai/phase-6.5-ui-polish.md` Wave 1's audit found `Dialog.Root` hand-wired
 * independently in six files — `card-detail-panel.tsx`, `archived-cards-
 * dialog.tsx`, `share-board.tsx`, `step-up.tsx`, `command-palette.tsx` (twice:
 * the palette itself and the shortcuts overlay), and `view-tabs.tsx`'s
 * `SaveViewDialog` — each with its own overlay opacity, its own size class,
 * its own border/shadow combination. None of them were WRONG; they had just
 * never been asked to agree with each other.
 *
 * This is a thin styled wrapper, not a single monolithic props object,
 * because the seven call sites disagree in real ways that a `title`/
 * `description`/`children` API cannot express without a pile of escape
 * hatches: `card-detail-panel.tsx` needs a header row with its OWN buttons
 * next to the title, and `command-palette.tsx`'s palette needs a visually
 * hidden title with a search input in its place. Composability is what lets
 * every one of those stay exactly as bespoke as it actually is, while the
 * overlay, the sizing, and the border/shadow/radius treatment stop being
 * reinvented per file.
 *
 * `ModalRoot`/`ModalTrigger`/`ModalClose` are Radix's own components,
 * re-exported unchanged — there is nothing to style on a component that
 * renders nothing itself.
 */
export const ModalRoot = Dialog.Root;
export const ModalTrigger = Dialog.Trigger;
export const ModalClose = Dialog.Close;

const MODAL_SIZES = {
  /* step-up.tsx, view-tabs.tsx's SaveViewDialog */
  sm: 'max-w-sm',
  /* archived-cards-dialog.tsx, share-board.tsx's original max-w-lg; also the
     default for anything that doesn't say otherwise. */
  md: 'max-w-md',
  lg: 'max-w-lg',
  /* card-detail-panel.tsx's two-column body */
  xl: 'max-w-4xl',
} as const;

export type ModalSize = keyof typeof MODAL_SIZES;

export interface ModalContentProps extends Omit<
  ComponentProps<typeof Dialog.Content>,
  'className'
> {
  readonly size?: ModalSize;
  /**
   * 'center' matches every dialog in the audit except one: the command
   * palette anchors near the top of the viewport rather than dead centre, so
   * it does not jump under the cursor's hand every time it opens.
   */
  readonly placement?: 'center' | 'top';
  readonly className?: string;
}

export function ModalContent({
  size = 'md',
  placement = 'center',
  className,
  children,
  ...props
}: ModalContentProps) {
  return (
    <Dialog.Portal>
      {/* `bg-overlay`, not the `bg-black/50` all seven call sites hardcoded —
          one token (`ai/phase-6.5-ui-polish.md` Wave 2) instead of six copies
          of the same magic number and a seventh that happened to also be
          bg-black/50 by coincidence rather than by reference to anything. */}
      <Dialog.Overlay className="ui-fade fixed inset-0 bg-overlay" />
      <Dialog.Content
        className={cn(
          /* `w-[calc(100vw-2rem)]`, not `w-full` — `w-full` resolves against
             the CENTERING TRANSFORM's containing block, which for a
             `position: fixed` element is the viewport, so a `max-w-sm`
             dialog on a 320px phone was already full-bleed edge to edge with
             zero margin (a phone's viewport IS 320px, so `w-full` computes to
             exactly that). The calc reserves 1rem on each side below every
             `max-w-*` breakpoint; above it, `max-w-*` takes over as the
             binding constraint and the calc term stops mattering. */
          'ui-fade fixed left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-card border border-line bg-surface-raised shadow-xl',
          /* `placement="top"`'s fixed 6rem offset (`top-24`) was sized for a
             desktop viewport with room to spare above the fold. On a short
             phone screen in landscape that offset alone can eat a third of
             the visible height before the command palette's own result list
             gets any of it — `top-6` below the `sm` breakpoint (640px, so
             this tracks viewport WIDTH as a proxy for "small device" the same
             way every other responsive class in this file does) leaves more
             room for results without moving the palette on any screen this
             was previously tuned for. */
          placement === 'center' ? 'top-1/2 -translate-y-1/2' : 'top-6 sm:top-24',
          MODAL_SIZES[size],
          className,
        )}
        {...props}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export function ModalTitle({ className, ...props }: ComponentProps<typeof Dialog.Title>) {
  return <Dialog.Title className={cn('text-sm font-semibold text-ink', className)} {...props} />;
}

export function ModalDescription({
  className,
  ...props
}: ComponentProps<typeof Dialog.Description>) {
  return <Dialog.Description className={cn('mt-1 text-xs text-ink-muted', className)} {...props} />;
}
