import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { Button, Field, FocusOnMountInput } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import type { SessionBody } from '../../lib/session.js';

/**
 * The TOTP challenge step (Phase 12 Wave 2 §3.2).
 *
 * One component, not two copies — `login-page.tsx` and `step-up.tsx` both
 * reach this the identical way: `auth.login` returned `totp_required`
 * instead of a session, because the account has a confirmed second factor.
 * `auth.totp.verifyLogin` is the only route that can turn the challenge
 * into a real session, with either a 6-digit code from the authenticator
 * app or a one-time recovery code.
 */
export function TotpChallengeForm({
  challengeToken,
  onSuccess,
}: {
  readonly challengeToken: string;
  readonly onSuccess: (session: SessionBody) => void;
}) {
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  const verify = useMutation({
    mutationFn: (input: { code: string; kind: 'totp' | 'recovery' }) =>
      api.auth.totp.verifyLogin.mutate({
        challengeToken,
        credential: { kind: input.kind, code: input.code },
      }),
    onSuccess,
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (code !== '') verify.mutate({ code, kind: useRecoveryCode ? 'recovery' : 'totp' });
      }}
    >
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Two-factor authentication</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {useRecoveryCode
            ? 'Enter one of your saved recovery codes.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </div>

      <Field label={useRecoveryCode ? 'Recovery code' : 'Code'} htmlFor="totp-code">
        <FocusOnMountInput
          id="totp-code"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
      </Field>

      {verify.isError && <ErrorView error={verify.error} />}

      <Button
        type="submit"
        variant="primary"
        className="w-full"
        disabled={verify.isPending || code === ''}
      >
        {verify.isPending ? 'Verifying…' : 'Verify'}
      </Button>

      <button
        type="button"
        className="text-xs text-ink-muted underline"
        onClick={() => {
          setUseRecoveryCode((current) => !current);
          setCode('');
        }}
      >
        {useRecoveryCode ? 'Use an authenticator code instead' : 'Use a recovery code instead'}
      </button>
    </form>
  );
}
