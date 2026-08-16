import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { Button, Field, Input } from '../../components/primitives.js';
import { BrandMark } from '../../components/brand-mark.js';
import { ErrorView } from '../../components/error-view.js';
import { fieldError, fieldErrors } from '../../lib/field-errors.js';

/**
 * Account creation.
 *
 * Success does NOT sign anyone in — the API answers `verification_sent` and
 * nothing else, because the address has not been proven yet. So this renders a
 * "check your email" state rather than navigating, and there is no token to
 * adopt even if it wanted to.
 *
 * The confirmation wording is identical whether or not the email was already
 * registered, matching what the API does. A signup form that says "that address
 * is taken" is an account-existence oracle that needs no password guesses at
 * all.
 */

interface FormValues {
  name: string;
  email: string;
  password: string;
}

export function RegisterPage() {
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { name: '', email: '', password: '' },
  });

  const create = useMutation({
    /* Trimmed but always sent — the API requires it now, so the old
       "omit when blank" branch would produce a request the server rejects on
       shape rather than a field error the form can render. */
    mutationFn: ({ name, ...rest }: FormValues) =>
      api.auth.register.mutate({ ...rest, name: name.trim() }),
  });

  if (create.isSuccess) {
    return (
      <div className="auth-backdrop min-h-full">
        <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            Check your email
          </h1>
          <p className="text-sm text-ink-muted">
            If that address can be registered, a verification link is on its way. The link is
            single-use and expires.
          </p>
          <Link to="/login" className="text-sm text-accent underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-backdrop min-h-full">
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-6 p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark size={44} />
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Create an account
          </h1>
        </div>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            void handleSubmit((values) => {
              create.mutate(values);
            })(event);
          }}
        >
          {/* The reason comes from the SERVER's `details`, never from a rule
            restated here. `Password` is `z.string().min(12)` in the API's
            router and nowhere else; a `minLength: 12` in this form would be a
            second copy of that number, free to drift the moment the policy
            changes — and the copy users see would be the one nobody tests. */}
          {/* Required, matching the API. Without it every surface that shows a
            person falls back to their email address — which quietly discloses
            it to everyone who can see a member list, a mention or an audit
            entry. One field at signup is the cheaper side of that trade. */}
          <Field label="Name" htmlFor="name" error={fieldError(create.error, 'name')}>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              aria-describedby={
                fieldError(create.error, 'name') === undefined ? undefined : 'name-error'
              }
              {...register('name', { required: true })}
            />
          </Field>

          <Field label="Email" htmlFor="email" error={fieldError(create.error, 'email')}>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              aria-describedby={
                fieldError(create.error, 'email') === undefined ? undefined : 'email-error'
              }
              {...register('email', { required: true })}
            />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            hint="At least 12 characters. Checked against known breach corpora."
            error={fieldError(create.error, 'password')}
          >
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              aria-describedby={
                fieldError(create.error, 'password') === undefined ? undefined : 'password-error'
              }
              {...register('password', { required: true })}
            />
          </Field>

          {/* Only shown when the failure was not attributable to a field — a rate
            limit, an outage. A duplicate banner repeating what is already
            beside the input trains people to ignore both. */}
          {create.isError && fieldErrors(create.error).length === 0 && (
            <ErrorView error={create.error} />
          )}

          <Button type="submit" variant="primary" className="w-full" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create account'}
          </Button>
        </form>

        <p className="text-sm text-ink-muted">
          Already have one?{' '}
          <Link to="/login" className="text-accent underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
