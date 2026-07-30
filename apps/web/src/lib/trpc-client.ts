import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import { z } from 'zod';
import type { AppRouter } from '@taskflow/api/router';
import { type ApiError, ERROR_CODES, type ErrorCode } from '@taskflow/contracts';
import { TRPC_URL } from './config.js';

/**
 * The tRPC client factory.
 *
 * Split from `trpc.ts` so `session.ts` can build an UNAUTHENTICATED client for
 * the refresh call without importing the authenticated one — which would be a
 * cycle (`trpc -> session -> trpc`), and `import-x/no-cycle` is an error.
 */

export type Client = ReturnType<typeof createTRPCClient<AppRouter>>;

export interface ClientOptions {
  /** Extra headers per request. Called on every batch, never cached. */
  readonly headers?: () => Promise<Record<string, string>> | Record<string, string>;
}

export function createClient(options: ClientOptions = {}): Client {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: TRPC_URL,
        ...(options.headers === undefined ? {} : { headers: options.headers }),

        /**
         * `same-origin`, not `include`.
         *
         * The refresh cookie is `__Host-` prefixed and `SameSite=Strict`, so it
         * is only ever sent same-site anyway — `include` would not make a
         * cross-origin deployment work, it would just stop this line from
         * documenting the assumption. If the API is ever served from a genuinely
         * different site, the cookie's own attributes are what has to be
         * reconsidered, and that is a security decision rather than a fetch
         * option.
         */
        fetch: (input, init) => {
          /* `signal` is pulled OUT of the spread rather than overwritten after
             it. tRPC types it `AbortSignal | undefined`; `RequestInit` under
             `exactOptionalPropertyTypes` wants `AbortSignal | null` and refuses
             an explicit `undefined`. Re-adding the key only when there is a
             signal is what keeps cancellation working — passing `null` would
             detach it, and a cancelled query would keep fetching. */
          const { signal, ...rest } = init ?? {};

          return fetch(input, {
            ...rest,
            ...(signal == null ? {} : { signal }),
            credentials: 'same-origin',
          });
        },
      }),
    ],
  });
}

/**
 * The domain fields the API's `errorFormatter` puts on a failure.
 *
 * It does NOT return an `ApiError` envelope over tRPC. tRPC wraps whatever the
 * formatter returns as `{ error: <shape> }`, so nesting our own `{ error: ... }`
 * inside would arrive as `error.error` and no client would look there. The
 * formatter therefore flattens the domain fields into `data` — the message stays
 * at the top level — and this schema is the mirror of that decision. The two
 * must be changed together; see apps/api/src/trpc/builder.ts.
 *
 * Parsed rather than cast. A proxy's HTML error page, a dropped connection, and
 * a version skew between this bundle and the deployed API all produce a
 * `TRPCClientError` with `data` that is not this shape, and none of them should
 * be presented to the user as though the server had explained itself.
 */
const ErrorData = z
  .object({
    code: z.enum(ERROR_CODES),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
  })
  // Not `.strict()`: `httpStatus` and tRPC's own `path` also travel in `data`,
  // and rejecting the whole envelope over an unrecognized sibling field would
  // turn a readable error into "something went wrong".
  .passthrough();

/**
 * Recovers the server's explanation of a failure, or null if it did not give
 * one.
 *
 * Returned in the `ApiError` shape from @taskflow/contracts so that the display
 * layer, the REST surface, and the API all speak about errors in the same terms.
 */
export function apiErrorOf(error: unknown): ApiError | null {
  if (!(error instanceof TRPCClientError)) return null;

  const parsed = ErrorData.safeParse(error.data);
  if (!parsed.success) return null;

  return {
    error: {
      code: parsed.data.code,
      /* The formatter's `message` is `envelope.error.message` — already the
         safe-to-display text from AppError, never an internal detail (§8.7). */
      message: error.message,
      requestId: parsed.data.requestId,
      ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
      ...(parsed.data.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: parsed.data.retryAfterSeconds }),
    },
  };
}

/** The error code, when the server supplied one. */
export function errorCodeOf(error: unknown): ErrorCode | null {
  return apiErrorOf(error)?.error.code ?? null;
}

/**
 * Whether a failure means "your session is no longer good".
 *
 * Deliberately narrow, in two directions.
 *
 * FORBIDDEN and NOT_A_MEMBER are also authorization failures, and treating them
 * as expiry would sign a user out for opening a page they simply cannot see.
 *
 * An UNPARSEABLE failure is not an expiry either. A dropped connection, a
 * proxy's 502, and a CORS rejection all arrive here with no envelope, and the
 * only safe reading is "we do not know" — which must not end a session that is
 * probably still valid. Signing out on a network blip is the failure mode this
 * function exists to avoid.
 *
 * Note which `code` is being read: the API's `errorFormatter` puts the DOMAIN
 * code in `data.code` and tRPC's own (`UNAUTHORIZED`) at the top level, so
 * comparing `data.code` against `'UNAUTHORIZED'` would never match anything.
 */
export function isUnauthenticated(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'UNAUTHENTICATED' || code === 'TOKEN_EXPIRED';
}
