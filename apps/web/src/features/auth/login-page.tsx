import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorOf, errorCodeOf } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { resetCache } from '../../lib/query.js';
import { useBranding } from '../../lib/branding-context.js';
import { Button, Field, Input } from '../../components/primitives.js';
import { BrandMark } from '../../components/brand-mark.js';
import { ErrorView } from '../../components/error-view.js';
import {
  browserSupportsWebAuthn,
  passkeyCeremonyMessage,
  PasskeyCeremonyError,
  signInWithPasskey,
} from './passkey.js';
import { TotpChallengeForm } from './totp-challenge.js';
import {
  OAUTH_PROVIDER_LABEL,
  redirectToAuthorization,
  useOAuthProviders,
  type OAuthProvider,
} from './oauth.js';
import type { SessionBody } from '../../lib/session.js';

/**
 * Password sign-in.
 *
 * ## What this form deliberately does not do
 *
 * It does not tell the user whether the email exists. The API answers
 * INVALID_CREDENTIALS identically for an unknown address and a wrong password
 * (Phase 1), and the display layer must not undo that by saying "no account
 * found" — an enumeration oracle built out of good intentions and a helpful
 * error message.
 *
 * It also does not validate the password beyond "present". Client-side rules
 * here would only tell an attacker which guesses are not worth sending, and the
 * real check — length, HIBP breach lookup — happens on registration, where it
 * belongs.
 */

interface FormValues {
  email: string;
  password: string;
}

export function LoginPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/login' });
  const adopt = useSession((state) => state.adopt);
  const queryClient = useQueryClient();
  const { productName } = useBranding();
  /* Computed once — a browser's WebAuthn support does not change over the
     component's lifetime, so there is nothing to re-derive on a later render. */
  const [passkeySupported] = useState(() => browserSupportsWebAuthn());
  /* Set when `auth.login` answers `totp_required` instead of a session — the
     account has a confirmed second factor, so the form beneath is swapped for
     `TotpChallengeForm` until that challenge is redeemed. Held alongside the
     email that produced it so the redeemed session still gets it (§8.1). */
  const [challenge, setChallenge] = useState<{ token: string; email: string } | null>(null);

  const { register, handleSubmit, formState } = useForm<FormValues>({
    defaultValues: { email: '', password: '' },
  });

  const afterSignIn = async (session: SessionBody, email?: string) => {
    // The email is remembered in memory so the step-up prompt (§8.1) does not
    // make someone retype their own address. Never persisted — see session.ts.
    adopt(session, email);
    /* A fresh sign-in must never render from the previous session's cache.
       Cheap here — the cache is nearly empty — and the alternative is another
       user's board appearing for a moment on a shared machine. */
    resetCache(queryClient);
    await navigate({ to: search.next ?? '/' });
  };

  const signIn = useMutation({
    mutationFn: (values: FormValues) => api.auth.login.mutate(values),
    onSuccess: (result, values) => {
      if (result.kind === 'totp_required') {
        setChallenge({ token: result.challengeToken, email: values.email });
        return;
      }
      void afterSignIn(result, values.email);
    },
  });

  const signInWithPasskeyMutation = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: (session) => afterSignIn(session),
  });

  /* The way out of EMAIL_NOT_VERIFIED (§8.1 follow-up): the account exists,
     the password was correct — `login` only reaches this error after
     confirming both — so there is a real inbox to send another link to.
     `resendVerification` answers `{ status: 'sent' }` unconditionally
     server-side either way, so this mutation never itself reveals anything
     login's own error didn't already. */
  const resendVerification = useMutation({
    mutationFn: (email: string) => api.auth.resendVerification.mutate({ email }),
  });

  const oauthProviders = useOAuthProviders();
  const startOAuth = useMutation({
    mutationFn: (provider: OAuthProvider) => api.auth.oauth.start.mutate({ provider }),
    onSuccess: (result) => {
      redirectToAuthorization(result.authorizationUrl);
    },
  });

  if (challenge !== null) {
    return (
      <div className="auth-backdrop min-h-full">
        <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center p-4">
          <div className="auth-card border border-line bg-surface-raised p-8">
            <TotpChallengeForm
              challengeToken={challenge.token}
              onSuccess={(session) => {
                void afterSignIn(session, challenge.email);
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-backdrop min-h-full">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center p-4">
        <div className="auth-card flex flex-col gap-6 border border-line bg-surface-raised p-8">
          <div className="flex flex-col items-center gap-3 text-center">
            {/* The product's mark — the uploaded logo when branding sets one,
              else the geometric accent-flow mark (`brand-mark.tsx`), on the
              one page every visitor sees before anything else. Sized as the
              hero here (the sidebar keeps it at 40px) — auth is the one
              screen the audit's own "bigger would be right" note applies to. */}
            <BrandMark size={64} />
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
                Sign in to {productName}
              </h1>
              {/* Body copy is Geist too — the redesign moved the whole app onto
                the self-hosted face (`styles.css` `--font-sans`), so there is
                no system-stack line to keep. */}
              <p className="mt-1.5 text-sm text-ink-muted">Use your email and password.</p>
            </div>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              void handleSubmit((values) => {
                signIn.mutate(values);
              })(event);
            }}
          >
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                {...register('email', { required: true })}
              />
            </Field>

            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password', { required: true })}
              />
            </Field>

            {/* EMAIL_NOT_VERIFIED gets its own block — the plain ErrorView leaves
            someone whose original mail never arrived with no way forward but
            to keep resubmitting the same form. Everything else (wrong
            password, unknown address, locked, suspended — all
            INVALID_CREDENTIALS, indistinguishable on purpose) still falls
            through to ErrorView. */}
            {signIn.isError &&
              (errorCodeOf(signIn.error) === 'EMAIL_NOT_VERIFIED' ? (
                <div className="rounded-md border border-line bg-surface-sunken p-3 text-sm">
                  <p className="text-ink">
                    {apiErrorOf(signIn.error)?.error.message ??
                      'Please verify your email address before signing in.'}
                  </p>
                  {resendVerification.isSuccess ? (
                    <p className="mt-1.5 text-xs text-ink-muted">
                      If that address has an account, a new link is on its way.
                    </p>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="mt-1.5"
                      disabled={resendVerification.isPending}
                      onClick={() => {
                        /* Both the `?.` and the `!== undefined` are load-bearing,
                         and ESLint reports both as unnecessary — because the
                         TYPE is wrong, not the code. TanStack Query declares a
                         mutation's `variables` as always present, and at
                         runtime it is `undefined` until the first `mutate()`
                         call. Deleting either guard to silence the warning
                         calls `resendVerification.mutate(undefined)`.

                         The same class of lie `lib/wire.ts` exists for: the
                         compiler agreeing with something that is not true at
                         the boundary. Disabled narrowly rather than fixed,
                         since the fix belongs upstream. */
                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above: TanStack Query types `variables` as non-optional, but it is undefined before the first mutate()
                        const email = signIn.variables?.email;
                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
                        if (email !== undefined) resendVerification.mutate(email);
                      }}
                    >
                      {resendVerification.isPending ? 'Sending…' : 'Resend verification email'}
                    </Button>
                  )}
                  {resendVerification.isError && <ErrorView error={resendVerification.error} />}
                </div>
              ) : (
                <ErrorView error={signIn.error} />
              ))}

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={signIn.isPending || formState.isSubmitting}
            >
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <div className="space-y-2 border-t border-line pt-4">
            {passkeySupported ? (
              <Button
                variant="secondary"
                className="w-full"
                disabled={signInWithPasskeyMutation.isPending}
                onClick={() => {
                  signInWithPasskeyMutation.mutate();
                }}
              >
                {signInWithPasskeyMutation.isPending
                  ? 'Waiting for your passkey…'
                  : 'Sign in with a passkey'}
              </Button>
            ) : (
              <p className="text-xs text-ink-faint">
                This browser does not support passkeys. Use your email and password instead.
              </p>
            )}

            {/* A cancelled or timed-out ceremony (§8.1: both report as the same
            `NotAllowedError`) shows nothing — it is not a failure, it is the
            user closing a prompt. Everything else gets a message: a genuine
            ceremony problem from `passkeyCeremonyMessage`, or the server's own
            answer via `ErrorView` for a completed-but-rejected assertion. */}
            {signInWithPasskeyMutation.isError &&
              (signInWithPasskeyMutation.error instanceof PasskeyCeremonyError ? (
                passkeyCeremonyMessage(signInWithPasskeyMutation.error.reason, productName) !==
                  null && (
                  <p role="alert" className="text-xs text-danger">
                    {passkeyCeremonyMessage(signInWithPasskeyMutation.error.reason, productName)}
                  </p>
                )
              ) : (
                <ErrorView error={signInWithPasskeyMutation.error} />
              ))}

            {/* An unconfigured provider renders no button at all (§3.3) rather
            than one that always fails — `oauthProviders.data` is undefined
            while loading, so nothing here flashes on then off. */}
            {(['google', 'github'] as const).map(
              (provider) =>
                oauthProviders.data?.[provider] === true && (
                  <Button
                    key={provider}
                    variant="secondary"
                    className="w-full"
                    disabled={startOAuth.isPending}
                    onClick={() => {
                      startOAuth.mutate(provider);
                    }}
                  >
                    {startOAuth.isPending && startOAuth.variables === provider
                      ? 'Redirecting…'
                      : `Sign in with ${OAUTH_PROVIDER_LABEL[provider]}`}
                  </Button>
                ),
            )}
            {startOAuth.isError && <ErrorView error={startOAuth.error} />}
          </div>

          <div className="flex justify-between text-sm text-ink-muted">
            <span>
              No account?{' '}
              <Link to="/register" className="text-accent underline">
                Create one
              </Link>
            </span>
            <Link to="/forgot-password" className="text-accent underline">
              Forgot password?
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
