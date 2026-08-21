import { useState } from 'react';
import { errorCodeOf } from './trpc-client.js';

/**
 * Wraps a mutation so a STEP_UP_REQUIRED failure prompts and then retries —
 * ported from `apps/web/src/features/auth/use-step-up.tsx`. Every mutation
 * `account.tsx`'s new sections carry (link/unlink an OAuth provider, enroll/
 * disable TOTP, remove a passkey, revoke a session, sign out everywhere) is
 * `stepUp: true` server-side (PLAN.md §8.1's four-routes-and-growing list),
 * and `apps/api/src/trpc/builder.ts`'s own comment on `StepUpDialog`
 * (`apps/web/src/features/auth/step-up.tsx`) is explicit about why this
 * cannot be satisfied by a silent token refresh: `authenticatedAt` is set
 * at LOGIN and a refresh deliberately never advances it, so a stolen
 * refresh token alone can never pass this gate — only a fresh password (or
 * passkey/TOTP) proof can. `step-up-sheet.tsx` is the mobile counterpart of
 * that dialog, using the identical `auth.native.login` /
 * `auth.native.totp.verifyLogin` pair `(auth)/sign-in.tsx` already uses,
 * since re-authenticating IS signing in again.
 *
 * Split from `step-up-sheet.tsx` for the same reason web's two files are
 * split: a module exporting both a hook and a component risks losing Fast
 * Refresh on the component (Metro's Fast Refresh has the identical
 * limitation React Native shares with Vite here), the same reason
 * `use-update-card.ts` sits beside its callers rather than inside one.
 *
 * The retry is stored as a THUNK, not as the mutation's captured variables —
 * a caller may need to re-run something composite, and re-running the exact
 * closure that failed (rather than reconstructing arguments) is what keeps
 * this generic across every section that uses it. Cleared before running so
 * a later, unrelated failure can never replay a stale action.
 */
export interface StepUpGuard {
  /** Returns true (and queues `retry`) when `error` is STEP_UP_REQUIRED; false otherwise, so the caller can fall through to its own error handling. */
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly pending: boolean;
  readonly confirm: () => void;
  readonly cancel: () => void;
}

export function useStepUp(): StepUpGuard {
  const [queued, setQueued] = useState<{ run: () => void } | null>(null);

  return {
    guard: (error, run) => {
      if (errorCodeOf(error) !== 'STEP_UP_REQUIRED') return false;
      setQueued({ run });
      return true;
    },
    pending: queued !== null,
    confirm: () => {
      const next = queued;
      setQueued(null);
      next?.run();
    },
    cancel: () => {
      setQueued(null);
    },
  };
}
