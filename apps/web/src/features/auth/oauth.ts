import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';

/**
 * OAuth sign-in, the browser half (Phase 12 Wave 2 §3.3).
 *
 * `auth.oauth.start`/`.startLink` both return an authorization URL and
 * nothing else — completing the flow means leaving the page entirely for
 * the provider's own consent screen, so there is no session or mutation
 * result to hand back here. `oauth-callback-page.tsx` is where the round
 * trip resumes.
 */

export type OAuthProvider = 'google' | 'github';

export const OAUTH_PROVIDER_LABEL: Readonly<Record<OAuthProvider, string>> = {
  google: 'Google',
  github: 'GitHub',
};

/**
 * Which providers this server has credentials for.
 *
 * A `publicRoute` query (`auth.oauth.providers`) rather than a `selfRoute`
 * one — the login page has no session to gate a self-scoped query behind,
 * and an unconfigured provider must render no button at all (§3.3) rather
 * than a button that always fails.
 */
export function useOAuthProviders() {
  return useQuery({
    queryKey: keys.oauthProviders(),
    queryFn: async () => wire(await api.auth.oauth.providers.query()),
  });
}

/**
 * Leaves the app for the provider's consent screen.
 *
 * A plain navigation, not a `<Link>` or a client-side route change — the
 * destination is on another origin entirely, and TanStack Router has no
 * involvement in getting there or coming back.
 */
export function redirectToAuthorization(authorizationUrl: string): void {
  window.location.href = authorizationUrl;
}
