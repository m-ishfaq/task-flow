import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

/**
 * The retry policy and `QueryClient` defaults (ai/phase-14-mobile.md §5, §12
 * decision 4) — the part of `apps/web`'s original `query.ts` that was
 * genuinely platform-agnostic, split out from the part that was not.
 *
 * `query.ts`'s `keys` registry and its `onOrgLost`/`recoverFromLostOrg`
 * machinery stayed in `apps/web` rather than moving here. Both are real
 * `apps/web` product surface — `keys` covers Chat, Docs, Search and Platform
 * Admin, none of which `apps/mobile` has a screen for yet, and the recovery
 * flow reads `useSession.getState()`, apps/web's own module-singleton store,
 * which has no equivalent shape in `apps/mobile`'s dependency-injected
 * `session.ts` (there is no global to read). Moving either now would be
 * exactly the premature-extraction risk Phase 6.5's "extract at the third
 * instance" rule warns about — mobile has no board query yet to prove the
 * shape against.
 */

/**
 * Classifies whether an error is worth retrying, without knowing HOW a
 * caller's tRPC client decides that — every app plugs in its own
 * `errorCodeOf`/`isUnauthenticated` (already near-identical between
 * `apps/web` and `apps/mobile`'s own `trpc-client.ts`), because this module
 * has no dependency on either.
 */
export interface RetryClassifiers {
  readonly isUnauthenticated: (error: unknown) => boolean;
  readonly errorCodeOf: (error: unknown) => string | null;
}

/**
 * Failures that retrying cannot fix. Ported verbatim from apps/web's
 * `query.ts` — see its own history for why each one is here.
 */
const TERMINAL_CODES = new Set([
  'FORBIDDEN',
  'NOT_A_MEMBER',
  'ORG_SUSPENDED',
  'ORG_BILLING_LAPSED',
  'NOT_FOUND',
  'GONE',
  'VALIDATION_FAILED',
  'CONFLICT',
  'ALREADY_EXISTS',
  'STEP_UP_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'QUOTA_EXCEEDED',
  'SERVICE_UNAVAILABLE',
]);

export function shouldRetry(
  classifiers: RetryClassifiers,
  failureCount: number,
  error: unknown,
): boolean {
  /* An expired access token is handled by the caller's own auth-header
     builder before the request is sent, so reaching here means the refresh
     itself failed — the session is gone, and retrying just repeats a
     signed-out request. */
  if (classifiers.isUnauthenticated(error)) return false;

  const code = classifiers.errorCodeOf(error);
  if (code !== null && TERMINAL_CODES.has(code)) return false;

  return failureCount < 2;
}

export interface QueryClientOptions extends RetryClassifiers {
  /**
   * Runs on every query/mutation cache error, from BOTH caches, on one
   * shared handler — apps/web's own NOT_A_MEMBER org-recovery is wired in
   * this way. Optional: a caller with nothing cache-level to react to (no
   * Wave 1 mobile screen has one yet) may omit it.
   */
  readonly onCacheError?: (error: unknown) => void;
}

/**
 * Builds a `QueryClient` with this codebase's shared defaults. Every value
 * here (staleTime, gcTime, refetch behaviour, retry policy, no automatic
 * mutation retries) is ported verbatim from apps/web's original
 * `createQueryClient` — see that file's own history for the reasoning
 * behind each one; nothing about the DEFAULTS is app-specific, only the
 * error classifiers and the cache-error hook are.
 */
export function createQueryClient(options: QueryClientOptions): QueryClient {
  const onError = options.onCacheError ?? ((): void => undefined);

  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),

    defaultOptions: {
      queries: {
        retry: (failureCount, error) => shouldRetry(options, failureCount, error),

        staleTime: 30_000,
        gcTime: 5 * 60_000,

        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },

      mutations: {
        /* Almost every mutation in this codebase is non-idempotent —
           `cards.create` twice is two cards — and a retry after an
           ambiguous timeout is how duplicates appear. */
        retry: false,
      },
    },
  });
}
