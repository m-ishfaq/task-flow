import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { resetCache } from '../../lib/query.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * Where every OAuth redirect lands (Phase 12 Wave 2 §3.3).
 *
 * `server.ts`'s `buildOAuthDeps` registers `${WEB_ORIGIN}/oauth/callback/
 * $provider` as the redirect URI with each provider — this path is a
 * published contract with Google's and GitHub's own consoles the same way
 * `router.tsx`'s comment on `verifyEmailRoute` describes for an emailed
 * link, and renaming it breaks sign-in for both providers until their
 * console configuration is updated to match.
 *
 * This is a full browser navigation away from the app and back, which loses
 * whatever access token existed in memory (`lib/session.ts`'s own reasoning
 * for why it lives there and nowhere more durable) — so this page never
 * assumes a prior session survived the round trip. The two outcomes
 * `auth.oauth.callback` can return are handled without it: a `session`
 * calls `adopt` directly, the same as password or passkey sign-in; a
 * `linked` outcome navigates away and lets `app.tsx`'s own boot-time
 * `restore()` recover the session that was live before the redirect, from
 * the httpOnly cookie it never touched.
 */
export function OAuthCallbackPage() {
  const { provider } = useParams({ from: '/oauth/callback/$provider' });
  const search = useSearch({ from: '/oauth/callback/$provider' });
  const navigate = useNavigate();
  const adopt = useSession((state) => state.adopt);
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<unknown>(null);

  // A plain string, not an Error object — a primitive is stable across
  // renders by value, so it does not force the effect below to re-run every
  // render the way a freshly constructed `new Error(...)` would.
  const linkErrorMessage =
    search.error !== undefined
      ? `${provider} did not complete: ${search.error}`
      : search.code === undefined || search.state === undefined
        ? 'This sign-in link is incomplete.'
        : null;

  // Effects run twice under StrictMode in development; the authorization
  // `code` is single-use, so a second exchange would fail anyway, but this
  // stops it from firing a second, confusing request in the meantime.
  const started = useRef(false);

  useEffect(() => {
    if (linkErrorMessage !== null || started.current) return;
    started.current = true;

    const code = search.code;
    const state = search.state;
    if (code === undefined || state === undefined) return; // narrows for TS; linkErrorMessage already covers this

    void (async () => {
      try {
        const result = await api.auth.oauth.callback.mutate({ provider, code, state });

        if (result.kind === 'linked') {
          await navigate({ to: '/account' });
          return;
        }

        adopt(result);
        // Same reasoning as login-page.tsx's afterSignIn: a fresh sign-in
        // must never render from a previous session's cache.
        resetCache(queryClient);
        await navigate({ to: '/' });
      } catch (caught) {
        setMutationError(caught);
      }
    })();
  }, [provider, search, linkErrorMessage, navigate, adopt, queryClient]);

  /* `linkErrorMessage` is rendered as plain text, never through `ErrorView` —
     `error-message.ts`'s own rule (§8.7) is that a shown message comes from
     the SERVER or a fixed table, never assembled client-side from an
     exception, precisely so a locally-thrown `Error` can never be mistaken
     for what the API actually said. This message IS locally authored (the
     link itself is malformed, before any request was made), so it gets its
     own paragraph instead. `mutationError` came back from a real request and
     goes through `ErrorView` like every other server failure in this app. */
  if (linkErrorMessage !== null || mutationError !== null) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold text-ink">Sign-in did not complete</h1>
        {linkErrorMessage !== null ? (
          <p className="text-sm text-danger">{linkErrorMessage}</p>
        ) : (
          <ErrorView error={mutationError} />
        )}
        <Link to="/login" className="text-sm text-accent underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-2 p-6">
      <p className="text-sm text-ink-muted">Signing you in…</p>
    </div>
  );
}
