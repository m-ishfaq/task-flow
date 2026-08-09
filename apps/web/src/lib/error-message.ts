import type { ErrorCode } from '@taskflow/contracts';
import { apiErrorOf } from './trpc.js';

/**
 * Turning a failure into a sentence a person can act on.
 *
 * Two rules, both from §8.7:
 *
 *   1. The message comes from the SERVER or from the short table below. It is
 *      never assembled from an exception — a thrown `Error` here could be a
 *      parse failure carrying a fragment of a response, and the API went to
 *      considerable trouble not to leak internals in its envelope.
 *   2. A failure the server did not explain says so, rather than inventing a
 *      cause. `FALLBACK` is for genuinely unreadable failures — a dropped
 *      connection, a proxy's HTML error page.
 *
 * Separate from `error-view.tsx` so it can be tested without rendering, and so
 * that file exports only components (react-refresh).
 */

/**
 * Wording for codes where the server's message is correct but unhelpful.
 *
 * Deliberately short. Most codes are NOT here — the server's own message is
 * better than a generic one, because it knows what was being attempted.
 */
const FRIENDLY: Partial<Record<ErrorCode, string>> = {
  NOT_A_MEMBER: 'You are not a member of this organization.',
  ORG_SUSPENDED: 'This organization has been suspended by a platform administrator.',
  FORBIDDEN: 'You do not have permission to do that.',
  STEP_UP_REQUIRED: 'Please sign in again to confirm this change.',
  CONFLICT: 'Someone else changed this first. Reload to see the current version.',
  RATE_LIMITED: 'Too many attempts.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',
};

export const FALLBACK =
  'Something went wrong, and the server did not say what. Check your connection and try again.';

/**
 * The message for a failure, including the wait when the server supplied one.
 *
 * `retryAfterSeconds` travels with RATE_LIMITED and QUOTA_EXCEEDED and is the
 * only part of those errors a user can act on. "Try again later" without it
 * means refreshing every few seconds, which on a sliding window extends the
 * block — the advice actively makes it worse.
 */
export function messageFor(error: unknown): string {
  const api = apiErrorOf(error);
  if (api === null) return FALLBACK;

  const base = FRIENDLY[api.error.code] ?? api.error.message;
  const wait = api.error.retryAfterSeconds;
  if (wait === undefined) return base;

  return `${base} You can try again in about ${humanizeSeconds(wait)}.`;
}

/**
 * A duration a person can act on.
 *
 * Rounded UP, always. Rounding 90 seconds down to "1 minute" invites a retry
 * that is still refused, and on a sliding window each refused retry pushes the
 * window out — so the friendly rounding is what keeps someone locked out.
 */
export function humanizeSeconds(seconds: number): string {
  if (seconds < 60) return `${String(Math.ceil(seconds))} seconds`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.ceil(minutes / 60);
  return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
}
