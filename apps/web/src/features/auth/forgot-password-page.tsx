import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { Button, Field, Input } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * Requesting a password-reset link.
 *
 * ## The confirmation is identical whether or not the address exists
 *
 * The API answers `{ status: 'sent' }` either way, and this page must not undo
 * that by rendering "no account found" — a form that distinguishes the two is an
 * account-existence oracle that needs no password guesses at all, and this one
 * is unauthenticated by definition.
 *
 * The wording therefore says "if that address has an account", which is both
 * honest and uninformative to someone probing.
 *
 * Rate limited to 3 per hour on the server (§8.9), because each request sends
 * mail to an address the requester does not control — so the limit is anti-spam
 * for other people's inboxes as much as it is abuse protection.
 */

interface FormValues {
  email: string;
}

export function ForgotPasswordPage() {
  const { register, handleSubmit } = useForm<FormValues>({ defaultValues: { email: '' } });

  const request = useMutation({
    mutationFn: (values: FormValues) => api.auth.requestPasswordReset.mutate(values),
  });

  if (request.isSuccess) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Check your email</h1>
        <p className="text-sm text-ink-muted">
          If that address has an account, a reset link is on its way. The link is single-use and
          expires.
        </p>
        <Link to="/login" className="text-sm text-accent underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Reset your password</h1>
        <p className="mt-1 text-sm text-ink-muted">We will email you a link to choose a new one.</p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          void handleSubmit((values) => {
            request.mutate(values);
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

        {request.isError && <ErrorView error={request.error} />}

        <Button type="submit" variant="primary" className="w-full" disabled={request.isPending}>
          {request.isPending ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>

      <Link to="/login" className="text-sm text-accent underline">
        Back to sign in
      </Link>
    </div>
  );
}
