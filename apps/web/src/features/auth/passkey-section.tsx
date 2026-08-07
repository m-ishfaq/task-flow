import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import {
  AddPanel,
  Button,
  ConfirmButton,
  Empty,
  FocusOnMountInput,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { useStepUp } from './use-step-up.js';
import { browserSupportsWebAuthn, enrollPasskey, passkeyCeremonyMessage, PasskeyCeremonyError } from './passkey.js';

/**
 * Passkey enrollment, listing, rename, and removal (PLAN.md §8.1).
 *
 * Personal, not org-scoped — a passkey signs into the ACCOUNT, and `list`,
 * `startRegistration`, `rename`, and `remove` are all `selfRoute` on the
 * server, taking the user from the verified token rather than from an org
 * membership. It lives under `features/auth` rather than `features/admin`
 * for the same reason: nothing here reads `orgId`, and the one caller today
 * (`admin/settings-page.tsx`) mounts it once regardless of which org is
 * selected.
 *
 * Errors are rendered inline (`ErrorText`), never toasted — the same choice
 * `MemberSection`/`TeamSection` make and `ProfileSection` does not: a section
 * that is itself a list of rows with their own controls has a natural place
 * for the failure to live right next to what caused it, and a toast on top
 * would just say the same thing twice.
 *
 * `enrollPasskey`/`browserSupportsWebAuthn` come from `./passkey.ts` — see
 * that file for what a "ceremony" is and why its failures collapse to a small
 * closed set rather than surfacing `error.message`.
 */
export function PasskeySection() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  /* Computed once — see login-page.tsx's identical pattern for why. */
  const [passkeySupported] = useState(() => browserSupportsWebAuthn());

  const passkeys = useQuery({
    queryKey: keys.passkeys(),
    queryFn: async () => wire(await api.auth.passkeys.list.query()),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.passkeys() });

  const enroll = useMutation({
    mutationFn: () => enrollPasskey(),
    onSuccess: refresh,
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) => api.auth.passkeys.rename.mutate(input),
    onSuccess: refresh,
  });

  /**
   * Removal is `stepUp: true` server-side (§8.1) — deleting an authenticator is
   * exactly what someone holding a stolen session would do first, to keep the
   * real owner out. `guard` reuses the same `StepUpDialog` `MemberSection`'s
   * removal already goes through; no new plumbing needed. When it is NOT a
   * step-up failure, `guard` returns `false` and the mutation's own error
   * state stays set, rendered by the `ErrorText` below — same as `remove` in
   * `MemberSection`.
   */
  const remove = useMutation({
    mutationFn: (id: string) => api.auth.passkeys.remove.mutate({ id }),
    onSuccess: refresh,
    onError: (error, id) => {
      guard(error, () => {
        remove.mutate(id);
      });
    },
  });

  return (
    <Section
      title="Passkeys"
      count={passkeys.data?.length}
      description="Sign in without a password. A passkey belongs to this device or your password manager, not to any one organization."
    >
      {passkeySupported ? (
        <AddPanel>
          <Button
            variant="primary"
            size="sm"
            disabled={enroll.isPending}
            onClick={() => {
              enroll.mutate();
            }}
          >
            {enroll.isPending ? 'Waiting for your device…' : 'Add a passkey'}
          </Button>

          {/* A cancelled or timed-out ceremony renders nothing — see
              login-page.tsx's identical check for why `passkeyCeremonyMessage`
              can return `null`. Anything else, ceremony or server, gets a
              message: the closed set for one, the server's own answer via
              `ErrorText` for the other. */}
          {enroll.isError &&
            (enroll.error instanceof PasskeyCeremonyError ? (
              passkeyCeremonyMessage(enroll.error.reason) !== null && (
                <p className="mt-2 text-xs text-danger">
                  {passkeyCeremonyMessage(enroll.error.reason)}
                </p>
              )
            ) : (
              <ErrorText error={enroll.error} />
            ))}
        </AddPanel>
      ) : (
        <p className="text-xs text-ink-faint">This browser does not support passkeys.</p>
      )}

      {passkeys.isPending && <SkeletonRows rows={2} className="*:h-12" />}
      {passkeys.isError && <ErrorView error={passkeys.error} title="Could not load passkeys" />}

      {passkeys.data?.length === 0 && (
        <Empty
          title="No passkeys yet"
          description="Add one to sign in without typing a password next time."
        />
      )}

      {passkeys.data !== undefined && passkeys.data.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {passkeys.data.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              busy={rename.isPending || remove.isPending}
              onRename={(name) => {
                rename.mutate({ id: passkey.id, name });
              }}
              onRemove={() => {
                remove.mutate(passkey.id);
              }}
            />
          ))}
        </ul>
      )}

      {rename.isError && <ErrorText error={rename.error} />}
      {/* A STEP_UP_REQUIRED failure opens the dialog above instead of landing
          here — see `remove`'s onError. Anything else does land here. */}
      {remove.isError && <ErrorText error={remove.error} />}

      {dialog}
    </Section>
  );
}

interface PasskeyRowProps {
  readonly passkey: {
    readonly id: string;
    readonly name: string | null;
    readonly deviceType: string;
    readonly backedUp: boolean;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
  };
  readonly busy: boolean;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}

function PasskeyRow({ passkey, busy, onRename, onRemove }: PasskeyRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(passkey.name ?? '');

  return (
    <li className="group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover">
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== '') {
                onRename(draft.trim());
                setEditing(false);
              }
            }}
          >
            <FocusOnMountInput
              value={draft}
              maxLength={64}
              className="h-7 text-xs"
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            <Button type="submit" size="sm" disabled={busy || draft.trim() === ''}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(passkey.name ?? '');
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <p className="truncate text-sm text-ink">{passkey.name ?? 'Unnamed passkey'}</p>
        )}
        <p className="text-[11px] text-ink-faint">
          {passkey.deviceType === 'multiDevice' ? 'Syncs across devices' : 'This device only'}
          {passkey.backedUp && ' · backed up'} · added {formatDate(passkey.createdAt)}
          {passkey.lastUsedAt !== null && ` · last used ${formatDateTime(passkey.lastUsedAt)}`}
        </p>
      </div>

      {!editing && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          className="focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
          onClick={() => {
            setEditing(true);
          }}
        >
          Rename
        </Button>
      )}

      <ConfirmButton
        label="Remove"
        confirmLabel={`Remove ${passkey.name ?? 'this passkey'}`}
        disabled={busy}
        onConfirm={onRemove}
        className="focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
      />
    </li>
  );
}
