import { useForm } from 'react-hook-form';
import { Link, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { Button, Field, Input } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { fieldError, fieldErrors } from '../../lib/field-errors.js';

/**
 * The destination of the link in a password-reset email.
 *
 * Path fixed by `packages/mail/src/templates.ts` — `/reset-password?token=` —
 * and, like the verification route, it cannot be renamed without breaking mail
 * that has already been sent.
 *
 * Possession of the emailed token IS the credential here: the route is public
 * because it is requested precisely by someone who cannot sign in. So the token
 * never leaves this page except in the reset call itself — it is not logged, not
 * put in a store, and not carried into the next navigation.
 */

interface FormValues {
  password: string;
}

export function ResetPasswordPage() {
  const { token } = useSearch({ from: '/reset-password' });
  const { register, handleSubmit } = useForm<FormValues>({ defaultValues: { password: '' } });

  const reset = useMutation({
    mutationFn: (values: FormValues) =>
      api.auth.resetPassword.mutate({ token: token ?? '', password: values.password }),
  });

  if (token === undefined) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
        <p className="text-sm text-ink-muted">
          This link is missing its token. Copy the whole URL from the email, including everything
          after the question mark.
        </p>
        <Link to="/forgot-password" className="text-sm text-accent underline">
          Request a new link
        </Link>
      </div>
    );
  }

  if (reset.isSuccess) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold text-ink">Password changed</h1>
        <p className="text-sm text-ink-muted">
          Every other session was signed out. Sign in with your new password.
        </p>
        <Link to="/login">
          <Button variant="primary">Go to sign in</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-lg font-semibold text-ink">Choose a new password</h1>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          void handleSubmit((values) => {
            reset.mutate(values);
          })(event);
        }}
      >
        <Field
          label="New password"
          htmlFor="password"
          hint="At least 12 characters. Checked against known breach corpora."
          error={fieldError(reset.error, 'password')}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...register('password', { required: true })}
          />
        </Field>

        {reset.isError && fieldErrors(reset.error).length === 0 && (
          <ErrorView error={reset.error} title="Could not reset your password" />
        )}

        <Button type="submit" variant="primary" className="w-full" disabled={reset.isPending}>
          {reset.isPending ? 'Saving…' : 'Set new password'}
        </Button>
      </form>

      <p className="text-sm text-ink-muted">
        Link expired?{' '}
        <Link to="/forgot-password" className="text-accent underline">
          Request a new one
        </Link>
      </p>
    </div>
  );
}
