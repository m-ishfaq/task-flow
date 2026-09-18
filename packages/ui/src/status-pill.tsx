import type { ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * A toned status indicator — success/danger/neutral, always a dot, never an
 * alert icon — extracted from three independent, near-identical
 * implementations found while wiring the warm-dark rebuild's component-
 * consolidation pass (ai/design-rebuild-warm-dark.md §3): platform-admin's
 * `orgs-tab.tsx` (`StatusBadge`), `billing-tab.tsx` (`BillingStatusBadge`),
 * and `operations-tab.tsx` (`OutcomeBadge`). All three shared the exact same
 * base classes and the exact same inconsistency: a danger-toned state
 * sometimes rendered a `ShieldAlert` icon and sometimes rendered nothing
 * beyond the dot, with no stated reason for which state got which — pure
 * per-author drift, not a deliberate distinction. This component always
 * renders a dot; the text label itself is what distinguishes "suspended"
 * from "past due" from "failed," so a decorative alert glyph on some states
 * and not others added visual noise without adding information.
 *
 * Deliberately NOT merged with this app's own `Badge` (`apps/web/src/
 * components/primitives.tsx`), even though both render a small pill: `Badge`
 * is a plain, neutral label (a role, a count) with no tone concept at all,
 * and most of its own call sites would never use one. Giving `Badge` a
 * `tone` prop nobody but the three status-pill call sites would set is the
 * same "capability with no real adoption" gap this rebuild's own research
 * already found once in `packages/ui` itself — two small, single-purpose
 * components are clearer than one component quietly serving two jobs.
 *
 * Lives in `packages/ui`, not `apps/web/src/components/primitives.tsx`: all
 * three known consumers are web-only today, but a status indicator is
 * exactly the kind of primitive `apps/mobile` will eventually want an
 * equivalent of, and this package is where a component goes once more than
 * one app might reasonably import it — the same reasoning that already
 * governs Modal/DropdownMenu/Popover living here.
 */

export type StatusPillTone = 'success' | 'danger' | 'neutral';

const TONE_CLASSES: Record<StatusPillTone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  neutral: 'border-line bg-surface-sunken text-ink-faint',
};

const DOT_CLASSES: Record<StatusPillTone, string> = {
  success: 'bg-success',
  danger: 'bg-danger',
  neutral: 'bg-ink-faint',
};

export interface StatusPillProps {
  readonly tone: StatusPillTone;
  readonly children: ReactNode;
  readonly className?: string;
}

export function StatusPill({ tone, children, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASSES[tone])}
      />
      {children}
    </span>
  );
}
