import { useState } from 'react';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { Button, Field, Input } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { TotpChallengeForm } from './totp-challenge.js';
import type { SessionBody } from '../../lib/session.js';

/**
 * Re-authenticating for a sensitive change (PLAN.md §8.1).
 *
 * Four routes carry `stepUp: true` — changing a member's role, removing a
 * member, granting a relationship tuple, revoking one. They are what an attacker
 * holding a stolen session reaches for first, and the window that matters is the
 * ten minutes an access token stays valid.
 *
 * ## Why this asks for a password rather than refreshing
 *
 * The server compares `authenticatedAt` against a five-minute ceiling, and a
 * REFRESH DELIBERATELY DOES NOT ADVANCE IT (identity.service.ts). That is the
 * whole point: if refreshing counted as proof, a stolen refresh token would
 * satisfy step-up indefinitely and the control would protect nothing.
 *
 * So this cannot be replaced by a silent retry, and a future "just call refresh
 * first" shortcut would quietly disable it.
 */

export interface StepUpDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Runs once a fresh credential proof has been recorded. */
  readonly onConfirmed: () => void;
}

export function StepUpDialog({ open, onClose, onConfirmed }: StepUpDialogProps) {
  const adopt = useSession((state) => state.adopt);
  const known = useSession((state) => state.email);

  const [email, setEmail] = useState(known ?? '');
  const [password, setPassword] = useState('');
  /* Set when `auth.login` answers `totp_required` — the account has a
     confirmed second factor, so the dialog swaps to `TotpChallengeForm`
     until that challenge is redeemed, same as the login page. */
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  const finish = (session: SessionBody) => {
    adopt(session, email);
    setPassword('');
    setChallengeToken(null);
    onClose();
    onConfirmed();
  };

  const reauthenticate = useMutation({
    mutationFn: (input: { email: string; password: string }) => api.auth.login.mutate(input),
    onSuccess: (result) => {
      if (result.kind === 'totp_required') {
        setChallengeToken(result.challengeToken);
        return;
      }
      finish(result);
    },
  });

  if (challengeToken !== null) {
    return (
      <ModalRoot
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <ModalContent size="sm" className="p-4">
          <TotpChallengeForm challengeToken={challengeToken} onSuccess={finish} />
        </ModalContent>
      </ModalRoot>
    );
  }

  return (
    <ModalRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ModalContent size="sm" className="p-4">
        <ModalTitle>Confirm it is you</ModalTitle>
        <ModalDescription>
          This change affects who can reach your organization, so it needs your password again.
        </ModalDescription>

        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (email !== '' && password !== '') reauthenticate.mutate({ email, password });
          }}
        >
          {/* Shown only when the address is not already known — after a reload
                the session is restored from the refresh cookie, which carries no
                email, and it is not persisted (an address in localStorage tells
                the next person at a shared machine who was last here). */}
          {known === null && (
            <Field label="Email" htmlFor="step-up-email">
              <Input
                id="step-up-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </Field>
          )}

          <Field label="Password" htmlFor="step-up-password">
            <Input
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </Field>

          {reauthenticate.isError && <ErrorView error={reauthenticate.error} />}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={reauthenticate.isPending || password === '' || email === ''}
            >
              {reauthenticate.isPending ? 'Confirming…' : 'Confirm'}
            </Button>
          </div>
        </form>
      </ModalContent>
    </ModalRoot>
  );
}
