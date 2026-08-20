import { queryOptions } from '@tanstack/react-query';
import { api } from './trpc.js';
import { keys } from './query.js';
import { wire, type Wire } from '@taskflow/client';

/**
 * The deployment's branding (migration 0073) — product name, logo, favicon,
 * and accent palette — as anyone may see it, signed in or not.
 *
 * `platformAdmin.branding.public` is a `publicRoute`, not a `selfRoute`: the
 * login page and the Docs public page both need this before any session
 * exists, the same reasoning `auth.oauth.providers` documents. It already
 * resolves through `branding-cache.ts`'s 30s TTL cache on the server, so this
 * query's own `staleTime` only controls how often THIS TAB re-asks — it is
 * not what makes a saved change appear elsewhere.
 */

type Output = Awaited<ReturnType<typeof api.platformAdmin.branding.public.query>>;
export type PublicBranding = Wire<Output>;

export function publicBrandingQuery() {
  return queryOptions({
    queryKey: keys.brandingPublic(),
    queryFn: async () => wire(await api.platformAdmin.branding.public.query()),
    staleTime: 5 * 60_000,
  });
}
