import { useState, type ReactNode } from 'react';
import { errorCodeOf } from '../../lib/trpc.js';
import { StepUpDialog } from './step-up.js';

/**
 * Wraps a mutation so a STEP_UP_REQUIRED failure prompts and then retries.
 *
 * Separate from `step-up.tsx` so each file exports one kind of thing: a module
 * exporting both a component and a hook loses fast refresh for the component,
 * and the editor silently full-reloads instead — the same reason
 * `use-update-card.ts` sits beside its callers rather than inside one.
 *
 * The retry is stored as a THUNK rather than as the mutation's variables,
 * because a caller may need to re-run something composite. It is cleared before
 * running so a later, unrelated failure cannot replay a stale action — replaying
 * "remove this member" because a different button failed would be the worst bug
 * this dialog could have.
 */
export function useStepUp(): {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly dialog: ReactNode;
} {
  const [pending, setPending] = useState<{ run: () => void } | null>(null);

  const guard = (error: unknown, run: () => void): boolean => {
    if (errorCodeOf(error) !== 'STEP_UP_REQUIRED') return false;
    setPending({ run });
    return true;
  };

  const dialog = (
    <StepUpDialog
      open={pending !== null}
      onClose={() => {
        setPending(null);
      }}
      onConfirmed={() => {
        const next = pending;
        setPending(null);
        next?.run();
      }}
    />
  );

  return { guard, dialog };
}
