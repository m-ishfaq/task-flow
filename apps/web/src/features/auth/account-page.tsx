import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Building2, Globe, Laptop, Smartphone } from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { keys, resetCache } from '../../lib/query.js';
import { wire } from '@taskflow/client';
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
  PageHeader,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from './use-step-up.js';
import { PasskeySection } from './passkey-section.js';
import { TotpSection } from './totp-section.js';
import { ConnectedAccountsSection } from './connected-accounts-section.js';
import { CalendarFeedSection } from './calendar-feed-section.js';
import { NotificationPreferencesSection } from '../notifications/notification-prefs-section.js';
import { RingtoneSection } from '../rtc/ringtone-section.js';
import { profileQuery, updateProfile } from '../people/api.js';

/**
 * The shape of one session returned by `auth.sessions.list`, after `wire()`.
 * Timestamps arrive as ISO strings through JSON, not Date objects.
 */
interface SessionView {
  readonly id: string;
  readonly label: string | null;
  readonly ip: string | null;
  readonly authenticatedAt: string;
  readonly lastSeenAt: string;
  readonly isCurrent: boolean;
  readonly country: string | null;
  readonly flagged: boolean;
}

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
 * device inventory yet (Phase 12 Wave 2 §3.4, a separate slice from this
 * one). Personal settings: profile, notification preferences, passkeys,
 * two-factor authentication (§3.2), connected OAuth accounts (§3.3), a
 * personal calendar feed (per-card opt-in sync), sign-out-everywhere, and
 * the list of organizations you belong to.
 */
export function AccountPage() {
  return (
    <div className="h-full min-h-0 overflow-y-auto mx-auto flex max-w-4xl flex-col gap-8 p-6 lg:p-8">
      <PageHeader
        title="Account"
        description="Yours alone — not tied to any organization, and the same wherever you sign in."
      />

      <CardShell>
        <AccountSection />
      </CardShell>

      <CardShell>
        <WorkingHoursSection />
      </CardShell>

      <CardShell>
        <NotificationPreferencesSection />
      </CardShell>

      <CardShell>
        <RingtoneSection />
      </CardShell>

      <CardShell>
        <PasskeySection />
      </CardShell>

      <CardShell>
        <TotpSection />
      </CardShell>

      <CardShell>
        <ConnectedAccountsSection />
      </CardShell>

      <CardShell>
        <CalendarFeedSection />
      </CardShell>

      <CardShell>
        <SessionsSection />
      </CardShell>

      <CardShell>
        <ExportDataSection />
      </CardShell>

      <CardShell>
        <OrganizationsSection />
      </CardShell>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Card shell — visual grouping
 * -------------------------------------------------------------------------- */

function CardShell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface-raised px-6 py-5">{children}</div>
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
    mutationFn: (displayName: string | null) => updateProfile({ displayName }),
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
 * Working hours, timezone & out-of-office
 * -------------------------------------------------------------------------- */

/**
 * The timezone, working-hours window and OOO state (Phase 11.5 Wave 1,
 * ai/phase-11.5-people.md §3.3–§3.4).
 *
 * Uses `people.profile.get`, not `auth.me` — the merged view carries the
 * timezone, hours and OOO fields the identity shape deliberately does not.
 * The timezone is the §3.3 fallback chain's result: the profile's own value,
 * then (if the database has it) Phase 9's quiet-hours timezone, then null —
 * and null is rendered as an explicit "set one" prompt rather than a guessed
 * zone, exactly the honesty the fallback exists to preserve.
 */
function WorkingHoursSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQuery());

  /* One `draft` object for all four controls, null until touched — the same
     discipline `AccountSection` uses, so the save cannot overwrite fields the
     user never looked at with values from a stale first render. */
  const [draft, setDraft] = useState<{
    timezone: string | null;
    workingHoursStart: string | null;
    workingHoursEnd: string | null;
    workingDays: readonly number[];
    oooFrom: string | null;
    oooUntil: string | null;
    oooMessage: string | null;
  } | null>(null);

  const value = draft ?? {
    timezone: profile.data?.timezone ?? null,
    workingHoursStart: profile.data?.workingHoursStart ?? null,
    workingHoursEnd: profile.data?.workingHoursEnd ?? null,
    workingDays: profile.data?.workingDays ?? [],
    oooFrom: profile.data?.oooFrom ?? null,
    oooUntil: profile.data?.oooUntil ?? null,
    oooMessage: profile.data?.oooMessage ?? null,
  };

  const saved = {
    timezone: profile.data?.timezone ?? null,
    workingHoursStart: profile.data?.workingHoursStart ?? null,
    workingHoursEnd: profile.data?.workingHoursEnd ?? null,
    workingDays: profile.data?.workingDays ?? [],
    oooFrom: profile.data?.oooFrom ?? null,
    oooUntil: profile.data?.oooUntil ?? null,
    oooMessage: profile.data?.oooMessage ?? null,
  };

  const dirty =
    draft !== null &&
    JSON.stringify({
      timezone: draft.timezone,
      workingHoursStart: draft.workingHoursStart,
      workingHoursEnd: draft.workingHoursEnd,
      workingDays: [...draft.workingDays].sort(),
      oooFrom: draft.oooFrom,
      oooUntil: draft.oooUntil,
      oooMessage: draft.oooMessage,
    }) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: updateProfile,
    onSuccess: () => {
      setDraft(null);
      /* Both views change — the merged profile is the source, but `auth.me`
         mirrors its displayName for the session bootstrap. */
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.profile() });
      toast.show('Working hours saved');
    },
    onError: (error) => {
      toast.failure('Your working hours were not saved', error);
    },
  });

  if (profile.isPending) return <SkeletonRows rows={3} className="*:h-9" />;
  if (profile.isError) {
    return <ErrorView error={profile.error} title="Could not load your profile" />;
  }

  const toggleDay = (day: number) => {
    setDraft({
      ...value,
      workingDays: value.workingDays.includes(day)
        ? value.workingDays.filter((existing) => existing !== day)
        : [...value.workingDays, day].sort((a, b) => a - b),
    });
  };

  return (
    <Section
      title="Working hours & timezone"
      description="Your working week and where you are — shown on your profile and used for scheduling."
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Timezone"
          htmlFor="profile-timezone"
          hint={
            value.timezone === null
              ? 'Not set — pick one so working hours and reminders land at the right time.'
              : undefined
          }
        >
          <Input
            id="profile-timezone"
            value={value.timezone ?? ''}
            placeholder="e.g. America/Chicago"
            onChange={(event) => {
              setDraft({
                ...value,
                timezone: event.target.value.trim() === '' ? null : event.target.value,
              });
            }}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Work starts" htmlFor="profile-hours-start">
            <Input
              id="profile-hours-start"
              type="time"
              value={value.workingHoursStart ?? ''}
              onChange={(event) => {
                setDraft({ ...value, workingHoursStart: event.target.value || null });
              }}
            />
          </Field>
          <Field label="Work ends" htmlFor="profile-hours-end">
            <Input
              id="profile-hours-end"
              type="time"
              value={value.workingHoursEnd ?? ''}
              onChange={(event) => {
                setDraft({ ...value, workingHoursEnd: event.target.value || null });
              }}
            />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1 block text-xs font-medium text-ink-muted">Working days</legend>
          <div className="flex flex-wrap gap-1">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => {
              const dayNumber = index + 1;
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={value.workingDays.includes(dayNumber)}
                  onClick={() => {
                    toggleDay(dayNumber);
                  }}
                  className={
                    value.workingDays.includes(dayNumber)
                      ? 'rounded px-2 py-1 text-xs font-medium bg-accent text-accent-ink'
                      : 'rounded px-2 py-1 text-xs text-ink-muted border border-line hover:bg-surface-hover'
                  }
                >
                  {day}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Out of office from"
            htmlFor="profile-ooo-from"
            hint="Leave empty to start immediately."
          >
            <Input
              id="profile-ooo-from"
              type="date"
              value={value.oooFrom?.slice(0, 10) ?? ''}
              onChange={(event) => {
                setDraft({ ...value, oooFrom: event.target.value || null });
              }}
            />
          </Field>
          <Field label="Returning" htmlFor="profile-ooo-until">
            <Input
              id="profile-ooo-until"
              type="date"
              value={value.oooUntil?.slice(0, 10) ?? ''}
              onChange={(event) => {
                setDraft({ ...value, oooUntil: event.target.value || null });
              }}
            />
          </Field>
        </div>

        <Field label="Out-of-office message" htmlFor="profile-ooo-message">
          <Input
            id="profile-ooo-message"
            value={value.oooMessage ?? ''}
            maxLength={200}
            placeholder="e.g. On leave, back with you soon"
            onChange={(event) => {
              setDraft({ ...value, oooMessage: event.target.value });
            }}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={save.isPending || !dirty}
            onClick={() => {
              save.mutate({
                timezone: value.timezone,
                workingHoursStart: value.workingHoursStart,
                workingHoursEnd: value.workingHoursEnd,
                workingDays: value.workingDays,
                oooFrom: value.oooFrom,
                oooUntil: value.oooUntil,
                oooMessage: value.oooMessage,
              });
            }}
          >
            Save working hours
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
              }}
            >
              Discard
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Sessions — grouped by device
 * -------------------------------------------------------------------------- */

/**
 * A parsed session label (e.g. "Chrome on macOS") used as the grouping key.
 * Sessions from the same browser/OS combination are treated as one device.
 */
function sessionDeviceKey(session: SessionView): string {
  return session.label ?? 'Unknown device';
}

/** A device group is the primary session plus a count of extras. */
interface DeviceGroup {
  readonly primary: SessionView;
  readonly extras: readonly SessionView[];
  readonly totalCount: number;
}

/**
 * Groups sessions by their user-agent label, keeping the most recently
 * active session as the primary entry for each device. Multiple logins
 * from the same browser collapse into one row.
 */
function groupSessionsByDevice(sessions: readonly SessionView[]): readonly DeviceGroup[] {
  const byDevice = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const key = sessionDeviceKey(session);
    const existing = byDevice.get(key);
    if (existing !== undefined) {
      existing.push(session);
    } else {
      byDevice.set(key, [session]);
    }
  }

  const groups: DeviceGroup[] = [];
  for (const deviceSessions of byDevice.values()) {
    // Sort by lastSeenAt descending — most recently active first.
    deviceSessions.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    const [first, ...rest] = deviceSessions;
    if (first === undefined) continue;
    groups.push({ primary: first, extras: rest, totalCount: deviceSessions.length });
  }

  // Sort groups: "This device" first, then by most-recently-active.
  groups.sort((a, b) => {
    if (a.primary.isCurrent) return -1;
    if (b.primary.isCurrent) return 1;
    return b.primary.lastSeenAt.localeCompare(a.primary.lastSeenAt);
  });

  return groups;
}

/**
 * Determine the appropriate icon for a device group based on its user-agent.
 */
function DeviceIcon({ label }: { readonly label: string | null }) {
  if (label === null) return <Globe className="h-4 w-4 text-ink-muted" />;

  const lower = label.toLowerCase();
  if (lower.includes('android') || lower.includes('iphone') || lower.includes('ipad')) {
    return <Smartphone className="h-4 w-4 text-ink-muted" />;
  }
  return <Laptop className="h-4 w-4 text-ink-muted" />;
}

function SessionsSection() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();

  /* §3.4 — the device inventory IS the active-sessions list. Each row is one
     sign-in; the current one is the session this request is running in. */
  const sessions = useQuery({
    queryKey: keys.sessions(),
    queryFn: async () => wire(await api.auth.sessions.list.query()),
  });

  const deviceGroups = useMemo(
    () => (sessions.data !== undefined ? groupSessionsByDevice(sessions.data.sessions) : []),
    [sessions.data],
  );

  const revoke = useMutation({
    mutationFn: (sessionId: string) => api.auth.sessions.revoke.mutate({ sessionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.sessions() });
      toast.show('That device has been signed out');
    },
    /* `sessionId` is the mutation's second argument — the retry needs to
       re-issue the SAME revocation after the step-up prompt, not the latest
       one. */
    onError: (error, sessionId) => {
      if (
        guard(error, () => {
          revoke.mutate(sessionId);
        })
      ) {
        return;
      }
      toast.failure('Could not sign that device out', error);
    },
  });

  /**
   * Revokes all EXTRA sessions for a device group (the extras, not the primary).
   */
  const revokeExtras = useMutation({
    mutationFn: (sessionIds: readonly string[]) =>
      Promise.all(sessionIds.map((id) => api.auth.sessions.revoke.mutate({ sessionId: id }))),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.sessions() });
      toast.show('Other sessions on that device signed out');
    },
    onError: (error, sessionIds) => {
      if (
        guard(error, () => {
          revokeExtras.mutate(sessionIds);
        })
      ) {
        return;
      }
      toast.failure('Could not sign out other sessions', error);
    },
  });

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
      count={sessions.data !== undefined ? deviceGroups.length : undefined}
      description="Every device currently signed in as you — grouped by browser."
    >
      {sessions.isPending && <SkeletonRows rows={2} className="*:h-10" />}
      {sessions.isError && (
        <ErrorView error={sessions.error} title="Could not load your sessions" />
      )}

      {sessions.data !== undefined && deviceGroups.length > 0 && (
        <ul className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/50">
          {deviceGroups.map((group) => (
            <li
              key={group.primary.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <DeviceIcon label={group.primary.label} />
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-ink">
                    {group.primary.label ?? 'Unknown device'}
                    {group.primary.isCurrent && <Badge>This device</Badge>}
                    {group.totalCount > 1 && (
                      <Badge className="text-ink-muted">{group.totalCount} sessions</Badge>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-ink-muted">
                    {group.primary.ip ?? 'No IP recorded'} · last seen{' '}
                    {formatDate(group.primary.lastSeenAt)}
                    {group.primary.flagged && (
                      <span className="text-warning">
                        {' '}
                        · unusual sign-in
                        {group.primary.country ? ` from ${group.primary.country}` : ''}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {group.extras.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revokeExtras.isPending}
                    onClick={() => {
                      revokeExtras.mutate(group.extras.map((e) => e.id));
                    }}
                  >
                    Close {group.extras.length} old{' '}
                    {group.extras.length === 1 ? 'session' : 'sessions'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={revoke.isPending}
                  onClick={() => {
                    revoke.mutate(group.primary.id);
                  }}
                >
                  Sign out
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {sessions.data?.sessions.length === 0 && (
        <Empty
          title="No active sessions"
          description="Every sign-in is listed here when one happens."
        />
      )}

      {sessions.data !== undefined && sessions.data.pushDeviceCount > 0 && (
        <p className="text-xs text-ink-faint">
          Push notifications are active on {sessions.data.pushDeviceCount}{' '}
          {sessions.data.pushDeviceCount === 1 ? 'device' : 'devices'}.
        </p>
      )}

      <div className="mt-3">
        <ConfirmButton
          label="Sign out everywhere"
          confirmLabel="Sign out of every device, including this one"
          disabled={signOutEverywhere.isPending}
          onConfirm={() => {
            signOutEverywhere.mutate();
          }}
        />
      </div>
      {dialog}
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Data export (Phase 12 Wave 2 §3.6)
 * -------------------------------------------------------------------------- */

/**
 * Self-serve DSAR export — downloads the caller's own account data as one
 * JSON document (profile, memberships across every org, active sessions,
 * connected OAuth identities). The server returns it inline; the audit
 * record is the `user.data_exported` event, never the document's contents.
 */
function ExportDataSection() {
  const toast = useToast();

  const download = useMutation({
    mutationFn: async () => wire(await api.people.profile.exportMine.query()),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `taskflow-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.show('Your data export is ready');
    },
    onError: (error) => {
      toast.failure('Could not export your data', error);
    },
  });

  return (
    <Section
      title="Your data"
      description="Everything this account holds about you — profile, memberships, active sessions and connected accounts, as one JSON document."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={download.isPending}
          onClick={() => {
            download.mutate();
          }}
        >
          {download.isPending ? 'Preparing…' : 'Export my data'}
        </Button>
        <span className="text-xs text-ink-faint">
          A self-serve export. Work, chat and docs you authored in organizations are not included.
        </span>
      </div>
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
        <ul className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/50">
          {orgs.data.map((org) => (
            <li key={org.orgId} className="flex items-center justify-between px-3 py-2.5 text-sm">
              <div className="flex items-center gap-2.5">
                <Building2 className="h-4 w-4 text-ink-muted" />
                <span className="text-ink">{org.name}</span>
              </div>
              <Badge>{org.role}</Badge>
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
