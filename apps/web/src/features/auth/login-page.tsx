import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { resetCache } from '../../lib/query.js';
import { Button, Field, Input } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import {
  browserSupportsWebAuthn,
  passkeyCeremonyMessage,
  PasskeyCeremonyError,
  signInWithPasskey,
} from './passkey.js';
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
  /* Computed once — a browser's WebAuthn support does not change over the
     component's lifetime, so there is nothing to re-derive on a later render. */
  const [passkeySupported] = useState(() => browserSupportsWebAuthn());

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
    onSuccess: (session, values) => afterSignIn(session, values.email),
  });

  const signInWithPasskeyMutation = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: (session) => afterSignIn(session),
  });

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Sign in to TaskFlow</h1>
        <p className="mt-1 text-sm text-ink-muted">Use your email and password.</p>
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

        {signIn.isError && <ErrorView error={signIn.error} />}

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
            passkeyCeremonyMessage(signInWithPasskeyMutation.error.reason) !== null && (
              <p role="alert" className="text-xs text-danger">
                {passkeyCeremonyMessage(signInWithPasskeyMutation.error.reason)}
              </p>
            )
          ) : (
            <ErrorView error={signInWithPasskeyMutation.error} />
          ))}
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
  );
}
