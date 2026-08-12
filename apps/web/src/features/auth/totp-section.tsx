import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import {
  AddPanel,
  Badge,
  Button,
  ConfirmButton,
  Field,
  FocusOnMountInput,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { useStepUp } from './use-step-up.js';

/**
 * TOTP enrollment (Phase 12 Wave 2 §3.2) — the gap this codebase's own status
 * header caught: `auth.totp.startEnrollment`/`confirmEnrollment`/`disable`
 * shipped with the login-time challenge (`totp-challenge.tsx`) already wired,
 * but nothing on the account page ever called them. This is that caller.
 *
 * Three states, held locally rather than derived from a route, because the
 * server has no notion of "enrollment in progress" beyond the unconfirmed row
 * `startEnrollment` writes — the wizard state (which screen to show) belongs
 * to this component the same way `PasskeySection`'s ceremony state does:
 *
 *   idle → enrolling (secret + code entry) → codes (recovery codes, once)
 *
 * `enrolling`/`codes` intentionally do not survive a reload. An abandoned
 * enrollment leaves an UNCONFIRMED row (`totp.service.ts`'s own header on why
 * that is safe: unusable for login or step-up), and refreshing mid-flow
 * dropping back to "enable two-factor" is the correct recovery, not a bug —
 * the alternative is a wizard that resumes into a state whose secret this
 * component no longer holds in memory.
 */
export function TotpSection() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [stage, setStage] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'enrolling'; readonly secret: string; readonly otpauthUrl: string }
    | { readonly kind: 'codes'; readonly codes: readonly string[] }
  >({ kind: 'idle' });
  const [code, setCode] = useState('');

  const status = useQuery({
    queryKey: keys.totpStatus(),
    queryFn: () => api.auth.totp.status.query(),
  });

  const refreshStatus = () => queryClient.invalidateQueries({ queryKey: keys.totpStatus() });

  const start = useMutation({
    mutationFn: () => api.auth.totp.startEnrollment.mutate(),
    onSuccess: (result) => {
      setStage({ kind: 'enrolling', secret: result.secret, otpauthUrl: result.otpauthUrl });
    },
    onError: (error) => {
      guard(error, () => {
        start.mutate();
      });
    },
  });

  const confirm = useMutation({
    mutationFn: (submittedCode: string) =>
      api.auth.totp.confirmEnrollment.mutate({ code: submittedCode }),
    onSuccess: (result) => {
      setStage({ kind: 'codes', codes: result.recoveryCodes });
      setCode('');
      void refreshStatus();
    },
    onError: (error) => {
      guard(error, () => {
        confirm.mutate(code);
      });
    },
  });

  /**
   * `stepUp: true` server-side (§8.1) — removing a second factor is exactly
   * the credential-adjacent change that list already covers, the same
   * reasoning `PasskeySection`'s `remove` and `ConnectedAccountsSection`'s
   * `unlink` give for their own disable/remove actions.
   */
  const disable = useMutation({
    mutationFn: () => api.auth.totp.disable.mutate(),
    onSuccess: () => {
      setStage({ kind: 'idle' });
      void refreshStatus();
    },
    onError: (error) => {
      guard(error, () => {
        disable.mutate();
      });
    },
  });

  return (
    <Section
      title="Two-factor authentication"
      description="Require a code from an authenticator app, in addition to your password, when signing in."
    >
      {status.isPending && <SkeletonRows rows={1} className="*:h-12" />}
      {status.isError && (
        <ErrorView error={status.error} title="Could not load your two-factor status" />
      )}

      {status.data !== undefined && stage.kind === 'idle' && (
        <>
          <div className="flex items-center justify-between">
            {status.data.enabled ? (
              <Badge className="bg-success/15 text-success">Enabled</Badge>
            ) : (
              <Badge>Not enabled</Badge>
            )}
            {status.data.enabled ? (
              <ConfirmButton
                label="Disable"
                confirmLabel="Disable two-factor authentication"
                disabled={disable.isPending}
                onConfirm={() => {
                  disable.mutate();
                }}
              />
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={start.isPending}
                onClick={() => {
                  start.mutate();
                }}
              >
                {start.isPending ? 'Starting…' : 'Enable two-factor authentication'}
              </Button>
            )}
          </div>
          {start.isError && <ErrorText error={start.error} />}
          {disable.isError && <ErrorText error={disable.error} />}
        </>
      )}

      {stage.kind === 'enrolling' && (
        <AddPanel>
          <p className="text-xs text-ink-muted">
            Scan this into an authenticator app (Google Authenticator, 1Password, or similar), or
            enter the code manually if it cannot scan:
          </p>
          <p className="mt-2 select-all break-all rounded bg-surface-hover px-2 py-1.5 font-mono text-xs text-ink">
            {stage.secret}
          </p>

          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (code !== '') confirm.mutate(code);
            }}
          >
            <Field label="Code from the app" htmlFor="totp-enroll-code">
              <FocusOnMountInput
                id="totp-enroll-code"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
            </Field>
            <Button type="submit" size="sm" disabled={confirm.isPending || code === ''}>
              {confirm.isPending ? 'Verifying…' : 'Confirm'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setStage({ kind: 'idle' });
                setCode('');
              }}
            >
              Cancel
            </Button>
          </form>
          {confirm.isError && <ErrorText error={confirm.error} />}
        </AddPanel>
      )}

      {stage.kind === 'codes' && (
        <AddPanel>
          <p className="text-xs text-ink-muted">
            Two-factor authentication is on. Save these recovery codes somewhere safe — each works
            once, if you ever lose access to your authenticator app, and this is the only time they
            are shown.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-1 rounded bg-surface-hover p-2 font-mono text-xs text-ink">
            {stage.codes.map((recoveryCode) => (
              <li key={recoveryCode} className="select-all">
                {recoveryCode}
              </li>
            ))}
          </ul>
          <Button
            className="mt-3"
            size="sm"
            onClick={() => {
              setStage({ kind: 'idle' });
            }}
          >
            Done
          </Button>
        </AddPanel>
      )}

      {dialog}
    </Section>
  );
}
