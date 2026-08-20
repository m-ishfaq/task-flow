import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@taskflow/api/router';

/**
 * The mobile tRPC client (ai/phase-14-mobile.md §5).
 *
 * Typed against the SAME `AppRouter` as apps/web and apps/api, so a drift
 * between the app and the API is a compile error here — guardrail 5 extended to
 * the phone, which is the whole reason this stack is React Native rather than a
 * native pair that would restate every wire type by hand.
 *
 * Two differences from the web client, both deliberate:
 *
 *   - NO cookie credentials. The web client sends `credentials: 'same-origin'`
 *     for its refresh cookie; a phone has no cookie and authenticates with a
 *     Bearer header it constructs per request (`deps.authHeaders`, from the
 *     session store). Nothing here reads or writes a cookie.
 *   - A client-type marker header. `x-taskflow-client: mobile` announces the
 *     native transport so the API can route to the native auth path (§4.3). It
 *     is a hint the server treats as untrusted — a browser cannot set it and be
 *     believed — never an authorization input.
 */
export type MobileTRPCClient = ReturnType<typeof createTRPCClient<AppRouter>>;

/** Header the API reads to distinguish the native client from the browser (§4.3). */
export const CLIENT_HEADER = 'x-taskflow-client';
export const MOBILE_CLIENT = 'mobile';

/**
 * The point past which a batched GET stops being safe to send. `httpBatchLink`
 * defaults `maxURLLength` to Infinity and packs every query firing in one tick
 * into a single URL; past a proxy's limit the WHOLE batch 414s. 2000 is the
 * long-standing "safe everywhere" URL length — the same value apps/web pins and
 * for the same reason.
 */
const MAX_BATCH_URL_LENGTH = 2000;

export interface MobileClientDeps {
  readonly trpcUrl: string;
  /** Per-request auth headers from the session store (Bearer + org). */
  authHeaders(): Promise<Record<string, string>>;
}

export function createMobileClient(deps: MobileClientDeps): MobileTRPCClient {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: deps.trpcUrl,
        maxURLLength: MAX_BATCH_URL_LENGTH,
        headers: async () => ({
          ...(await deps.authHeaders()),
          [CLIENT_HEADER]: MOBILE_CLIENT,
        }),
      }),
    ],
  });
}
