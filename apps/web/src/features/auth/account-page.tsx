import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '../../lib/trpc.js';
import { keys, resetCache } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';
import { formatDate } from '../../lib/format.js';
import { signOut } from '../../lib/session.js';
import { disconnectSocket } from '../../lib/socket.js';
import { disconnectChatSocket } from '../../lib/chat-socket.js';
import { orgsQuery } from '../org/api.js';
import {
  Badge,
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from './use-step-up.js';
import { PasskeySection } from './passkey-section.js';

/**
 * The personal account page (`ai/account-page.md`).
 *
 * Everything here is `selfRoute` server-side and answers with no org selected
 * — that is the entire reason this page exists as something other than a
 * section of `admin/settings-page.tsx`. `PasskeySection` moved here verbatim:
 * it never depended on an org, and was only reachable through an org-gated
 * page before this, which is a real bug this page fixes rather than a
 * cosmetic reorganization.
 *
 * Deliberately NOT §3.5's "People" surface — no org directory, no teams, no
 * session/device inventory (PLAN.md names that last one as still deferred).
 * Four sections, all personal: profile, passkeys, sign-out-everywhere, and the
 * list of organizations you belong to.
 */
export function AccountPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Account</h1>
        <p className="text-xs text-ink-muted">
          Yours alone — not tied to any organization, and the same wherever you sign in.
        </p>
      </div>

      <AccountSection />
      <PasskeySection />
      <SessionsSection />
      <OrganizationsSection />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Profile
 * -------------------------------------------------------------------------- */

function AccountSection() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const me = useQuery({
    queryKey: keys.me(),
    queryFn: async () => wire(await api.auth.me.query()),
  });

  /* `null` means "not edited yet", same reasoning the old org-scoped profile
     editor used: initialising from `me.data` directly would freeze the field
     at whatever loaded first — before the query settles, that is an empty box
     that silently overwrites a real name on save. */
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? me.data?.displayName ?? '';

  const save = useMutation({
    mutationFn: (displayName: string | null) => api.auth.updateProfile.mutate({ displayName }),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      toast.show('Name saved');
    },
    onError: (error) => {
      toast.failure('Your name was not saved', error);
    },
  });

  if (me.isPending) return <SkeletonRows rows={3} className="*:h-9" />;
  if (me.isError) return <ErrorView error={me.error} title="Could not load your account" />;

  return (
    <Section
      title="Profile"
      description="How your name appears to everyone else, in every organization."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // An empty box clears the name, which is a real operation: it goes
          // back to showing the email address. Not the same as "leave it alone".
          save.mutate(value.trim() === '' ? null : value.trim());
        }}
      >
        <Field label="Email" htmlFor="account-email">
          <Input id="account-email" value={me.data.email} disabled />
        </Field>

        <Field
          label="Display name"
          htmlFor="display-name"
          hint="Leave empty to be shown by your email address instead."
        >
          <Input
            id="display-name"
            value={value}
            maxLength={80}
            placeholder="Your name"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            Save
          </Button>
          <Badge {...(me.data.emailVerified ? {} : { className: 'text-warning' })}>
            {me.data.emailVerified ? 'Email verified' : 'Email not verified'}
          </Badge>
          <span className="text-xs text-ink-faint">
            Member since {formatDate(me.data.createdAt)}
          </span>
        </div>
      </form>
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Sessions
 * -------------------------------------------------------------------------- */

function SessionsSection() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();

  /**
   * Ends every session, including this tab's — `logoutEverywhere` revokes ALL
   * of the caller's sessions with no exception for the one making the request
   * (`repository.ts`'s `revokeAllSessions`). So a success here has to run the
   * exact local cleanup `AccountMenu`'s own sign-out does (shell.tsx): clear
   * the query cache, drop both sockets, and leave for `/login` — otherwise
   * this tab would sit on a page believing it still has a live session it no
   * longer holds.
   *
   * Step-up protected server-side (§8.1) for the obvious reason: it is exactly
   * what someone holding a stolen session would use to lock the real owner
   * out of every device at once.
   */
  const signOutEverywhere = useMutation({
    mutationFn: () => api.auth.logoutEverywhere.mutate(),
    onSuccess: async () => {
      await signOut();
      resetCache(queryClient);
      disconnectSocket();
      disconnectChatSocket();
      await navigate({ to: '/login' });
    },
    onError: (error) => {
      if (
        guard(error, () => {
          signOutEverywhere.mutate();
        })
      ) {
        return;
      }
      toast.failure('Could not sign out other devices', error);
    },
  });

  return (
    <Section
      title="Sessions"
      description="Sign out of this device and every other one where you are currently signed in."
    >
      <ConfirmButton
        label="Sign out everywhere"
        confirmLabel="Sign out of every device, including this one"
        disabled={signOutEverywhere.isPending}
        onConfirm={() => {
          signOutEverywhere.mutate();
        }}
      />
      {dialog}
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Organizations
 * -------------------------------------------------------------------------- */

function OrganizationsSection() {
  const orgs = useQuery(orgsQuery());

  return (
    <Section
      title="Organizations"
      count={orgs.data?.length}
      description="Every organization you belong to, and your role in each."
    >
      {orgs.isPending && <SkeletonRows rows={2} className="*:h-10" />}
      {orgs.isError && <ErrorView error={orgs.error} title="Could not load your organizations" />}

      {orgs.data?.length === 0 && (
        <Empty
          title="No organizations yet"
          description="Create or join one to get started."
          action={
            <Link to="/orgs" className="text-sm text-accent underline">
              Go to organizations
            </Link>
          }
        />
      )}

      {orgs.data !== undefined && orgs.data.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {orgs.data.map((org) => (
            <li key={org.orgId} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-ink">{org.name}</span>
              <span className="text-[11px] text-ink-faint">{org.role}</span>
            </li>
          ))}
        </ul>
      )}

      <Link to="/orgs" className="text-xs text-accent underline">
        Manage organizations
      </Link>
    </Section>
  );
}
