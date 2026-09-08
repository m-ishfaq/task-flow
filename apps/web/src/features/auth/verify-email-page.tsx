import { useEffect, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { Button, Spinner } from '../../components/primitives.js';
import { BrandMark } from '../../components/brand-mark.js';
import { ErrorView } from '../../components/error-view.js';
import { clearPendingNext, peekPendingNext } from '../../lib/pending-next.js';

/**
 * The destination of the link in a verification email.
 *
 * The path is fixed by `packages/mail/src/templates.ts` — `/verify-email?token=`
 * — and mail already delivered cannot be corrected, so this route exists to
 * match it and its path must not change. A rename breaks every outstanding link
 * in every inbox, retroactively, with no way to tell who is affected.
 *
 * ## Why confirming takes a click instead of happening on load
 *
 * The first version fired the mutation from a `useEffect` on mount. It hung
 * forever on "Confirming…", and the reason is worth writing down because it is
 * invisible from the server:
 *
 * React's StrictMode deliberately mounts, unmounts and remounts a component in
 * development. `mutate()` was called during the FIRST mount; React then threw
 * that mount away, and with it the mutation observer that would have received
 * the result. The request completed — the server logged a perfectly good
 * response — and it was delivered to an observer that no longer existed. The
 * remounted component sat at `pending` with nothing to resolve it.
 *
 * A ref guard does not help. It correctly stops the SECOND call, which is what
 * makes the symptom so confusing: exactly one request, one response, and a UI
 * that never hears about it.
 *
 * The fix is to stop starting side effects from the lifecycle. A click is not a
 * workaround for StrictMode — it removes a whole class of problem:
 *
 *   - it cannot be double-invoked, prefetched, or replayed by a remount;
 *   - the token is SINGLE-USE, and mail security gateways and chat
 *     link-previewers follow links — some executing JavaScript. An
 *     auto-confirming page lets a scanner spend the token before the human ever
 *     sees it, and there is no recovery except registering again;
 *   - a failure becomes actionable, because the button is still there to retry.
 *
 * `verify-email-page.test.tsx` renders this inside `StrictMode`, which is what
 * the app actually does, so the original bug fails a test rather than a person.
 */
export function VerifyEmailPage() {
  const { token } = useSearch({ from: '/verify-email' });

  const verify = useMutation({
    mutationFn: (value: string) => api.auth.verifyEmail.mutate({ token: value }),
  });

  /* A lazy initializer, not a bare call in the render body — see
     `pending-next.ts`'s own header on why peeking and clearing are split
     across an initializer and an effect. `RegisterPage` stashed this
     BEFORE submitting, on the chance registration itself never completed
     (a network failure, a closed tab) — so this may be stale or absent,
     and that is fine: `PendingNextLink` below falls back to a plain
     `/login` with no destination when it is null. */
  const [pendingNext] = useState(() => peekPendingNext());

  useEffect(() => {
    if (verify.isSuccess) clearPendingNext();
  }, [verify.isSuccess]);

  if (token === undefined) {
    return (
      <Frame>
        <p className="text-sm text-ink-muted">
          This link is missing its token. Copy the whole URL from the email, including everything
          after the question mark.
        </p>
        <Link to="/register" className="text-sm text-accent underline">
          Register again to get a new link
        </Link>
      </Frame>
    );
  }

  if (verify.isSuccess) {
    return (
      <Frame>
        <p className="text-sm text-ink">Your email address is confirmed. You can sign in now.</p>
        <Link to="/login" search={{ next: pendingNext ?? undefined }}>
          <Button variant="primary">Go to sign in</Button>
        </Link>
      </Frame>
    );
  }

  return (
    <Frame>
      {verify.isError && (
        <>
          {/* A spent link and a forged one get the SAME answer from the server —
              NOT_FOUND either way, deliberately, so this page cannot be used to
              probe whether a token exists. The wording covers both rather than
              guessing which happened. */}
          <ErrorView error={verify.error} title="That link did not work" />
          <p className="text-sm text-ink-muted">
            Verification links are single-use and expire. If you have already confirmed this
            address, just sign in; otherwise register again for a fresh link.
          </p>
        </>
      )}

      {!verify.isError && (
        <p className="text-sm text-ink-muted">
          Confirm that you own this address to finish setting up your account.
        </p>
      )}

      <Button
        variant="primary"
        disabled={verify.isPending}
        onClick={() => {
          verify.mutate(token);
        }}
      >
        {verify.isPending ? (
          <>
            <Spinner /> Confirming…
          </>
        ) : verify.isError ? (
          'Try again'
        ) : (
          'Confirm my email address'
        )}
      </Button>

      {verify.isError && (
        <div className="flex gap-2">
          <Link to="/login" search={{ next: pendingNext ?? undefined }}>
            <Button>Sign in</Button>
          </Link>
          <Link to="/register" search={{ next: pendingNext ?? undefined }}>
            <Button variant="ghost">Register again</Button>
          </Link>
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
      <BrandMark size={36} className="text-accent" />
      <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
        Email verification
      </h1>
      {children}
    </div>
  );
}
