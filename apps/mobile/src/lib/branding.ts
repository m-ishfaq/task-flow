import { queryOptions } from '@tanstack/react-query';
import { wire, type Wire } from '@taskflow/client';
import { apiClient } from './app-session.js';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * The deployment's branding (migration 0073) — product name, logo, and
 * accent palette — as anyone may see it, signed in or not. Ported from
 * `apps/web/src/lib/branding.ts`; see that file's own header for why
 * `platformAdmin.branding.public` is a `publicRoute` rather than even a
 * `selfRoute`, and `branding-provider.tsx`'s header for why this fires
 * before `session.restore()` has even settled.
 *
 * `apiClient`, not a second anonymous client: its `authHeaders()` omits the
 * `authorization` header entirely when there is no session (`session.ts`'s
 * own `authHeaders` — `token === null ? {} : ...`), which is exactly what an
 * unauthenticated `publicRoute` needs. No dependency loop either way, unlike
 * `session`'s own refresh call: this query never runs from inside
 * `apiClient`'s own header resolution.
 *
 * Carries `faviconUrl` in the wire type, same as web — `branding-context.ts`'s
 * own `BrandingValue` is the narrower shape that actually drops it, since
 * nothing on this platform has a browser tab to put one in.
 */

type Output = Awaited<ReturnType<MobileTRPCClient['platformAdmin']['branding']['public']['query']>>;
export type PublicBranding = Wire<Output>;

export const BRANDING_QUERY_KEY = ['platformAdmin.branding.public'] as const;

export function publicBrandingQuery() {
  return queryOptions({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: async () => wire(await apiClient.platformAdmin.branding.public.query()),
    staleTime: 5 * 60_000,
  });
}
