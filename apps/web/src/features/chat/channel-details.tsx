import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, Lock, Pencil, Users, X } from 'lucide-react';
import type { ChannelId, UserId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { useToast } from '../../lib/toast-context.js';
import { Avatar, Button, ConfirmButton, Empty, Field, Input } from '../../components/primitives.js';
import { useMembers, type Person } from '../org/use-members.js';
import { CallButton } from '../telephony/call-button.js';
import { directoryMemberQuery } from '../people/api.js';
import { CallsSection, FilesSection, PinnedSection, SavedSection } from './channel-media.js';
import {
  addChannelMember,
  exportChannel,
  guestsQuery,
  holdChannel,
  invalidateChannelGuests,
  setGuestAccess,
  setRetention,
  type ChannelDetail,
  type ChannelGuestRow,
  archiveChannel,
  channelQuery,
  invalidateChannel,
  invalidateChannels,
  removeChannelMember,
  updateChannel,
} from './api.js';

/**
 * The channel details panel — roster, settings, and leaving
 * (PLAN.md §3.2; ai/phase-5-chat.md §3.9).
 *
 * ## Every control is rendered; the server decides
 *
 * There is no `role === 'admin'` here, and no "can I manage this channel"
 * computed anywhere in this file. §8.2 is explicit that a UI reimplementing
 * `can()` produces two models that drift, and the one users actually hit is the
 * one nobody tests — so Rename, Archive and Remove are all shown, and a caller
 * who lacks `channel:manage` gets an honest FORBIDDEN toast rather than a
 * hidden button that leaves them wondering what they did wrong.
 *
 * The one exception is authorship-shaped and is not authorization: "Leave" and
 * "Remove" are the same route (`removeMember`) distinguished only by whether
 * the target is the viewer, which the client already knows for certain. Naming
 * them differently is a labelling decision, not a permission check.
 *
 * ## Why a DM's roster is read-only
 *
 * A DM's participants are fixed at creation, and the service refuses both
 * `addMember` and `removeMember` on one. The panel does not render those
 * controls for a DM — not to re-derive the rule, but because the alternative is
 * offering a button whose only possible outcome is an error message. Adding a
 * third person to a two-person conversation would expose its entire history to
 * someone who was never part of it; the group they want is a NEW channel.
 */

export function ChannelDetailsPanel({
  orgId,
  channelId,
  onClose,
  presence = [],
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly onClose: () => void;
  readonly presence?: readonly string[];
}) {
  const channel = useQuery(channelQuery(orgId, channelId));
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editingSettings, setEditingSettings] = useState(false);

  const data = channel.data;
  const isDirect = data?.type === 'dm' || data?.type === 'group_dm';
  const onlineUserIds = new Set(presence.filter((id) => id !== viewerId));

  /* Both queries, on every membership change. The roster lives on this panel
     and the "joined" flag lives on the sidebar row, so refreshing one and not
     the other leaves whichever was skipped showing the previous answer. */
  const refresh = (): void => {
    invalidateChannel(queryClient, orgId, channelId);
    invalidateChannels(queryClient, orgId);
  };

  const remove = useMutation({
    mutationFn: (userId: UserId) => removeChannelMember(channelId, userId),
    onSuccess: refresh,
    onError: (error) => {
      toast.failure('They were not removed', error);
    },
  });

  const archive = useMutation({
    mutationFn: () => archiveChannel({ channelId, restored: data?.archivedAt !== null }),
    onSuccess: () => {
      refresh();
      toast.show(data?.archivedAt === null ? 'Channel archived' : 'Channel restored');
    },
    onError: (error) => {
      toast.failure('The channel was not archived', error);
    },
  });

  /* Below `md` this panel is a full-width overlay on top of the conversation
     (the channel pane in `ChannelPanel` is the `relative` parent) rather
     than a fixed-width sibling squeezing it — a phone has ~360px, and a 288px
     sidebar next to the message column leaves the conversation a sliver.
     `md:static md:w-72` restores the side-by-side layout above the
     breakpoint; the panel's own ✕ returns to the conversation either way. */
  if (data === undefined) {
    return (
      <aside className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-surface-raised md:static md:w-72">
        <PanelHeader title="Details" onClose={onClose} />
      </aside>
    );
  }

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line md:static md:w-72 bg-surface-raised">
      <PanelHeader title="Details" onClose={onClose} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {editingSettings && data.type !== 'dm' && data.type !== 'group_dm' ? (
          <div className="p-4">
            <ChannelSettingsForm
              orgId={orgId}
              channelId={channelId}
              name={data.name ?? ''}
              topic={data.topic}
              onDone={() => {
                setEditingSettings(false);
              }}
            />
          </div>
        ) : (
          <>
            {/* Identity header — centered avatar/icon, name, context. */}
            <IdentityHeader
              orgId={orgId}
              data={data}
              viewerId={viewerId}
              personOf={personOf}
              onlineUserIds={onlineUserIds}
              onEdit={() => {
                setEditingSettings(true);
              }}
            />

            <div className="flex flex-col gap-4 p-4">
              {/* A true 1:1 DM has nothing left to list here — the header
                  above already shows the only other person. A group DM or
                  an ordinary channel gets the real roster. */}
              {data.type !== 'dm' && (
                <MemberRoster
                  memberIds={data.memberIds}
                  viewerId={viewerId}
                  personOf={personOf}
                  onlineUserIds={onlineUserIds}
                  removable={!isDirect}
                  onRemove={(userId) => {
                    remove.mutate(userId);
                  }}
                />
              )}

              {!isDirect && (
                <AddMemberControl
                  orgId={orgId}
                  channelId={channelId}
                  memberIds={data.memberIds}
                  onAdded={refresh}
                />
              )}

              {/* The "just like WhatsApp" group-info surfaces — what has been
                  called, pinned, starred by you, and shared, all in this one
                  conversation. */}
              <CallsSection orgId={orgId} channelId={channelId} />
              <PinnedSection orgId={orgId} channelId={channelId} personOf={personOf} />
              <SavedSection orgId={orgId} channelId={channelId} />
              <FilesSection orgId={orgId} channelId={channelId} />

              {!isDirect && data.capabilities.manage && (
                <ComplianceAndGuests orgId={orgId} channelId={channelId} channel={data} />
              )}

              {!isDirect && (
                <section className="border-t border-line pt-3">
                  <ConfirmButton
                    label={data.archivedAt === null ? 'Archive channel' : 'Restore channel'}
                    confirmLabel={data.archivedAt === null ? 'Archive it' : 'Restore it'}
                    onConfirm={() => {
                      archive.mutate();
                    }}
                  />
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * A person, as two lines: what to call them, and their address.
 *
 * ## Why the second line is conditional
 *
 * A display name is optional (migration 0019), and `personOf` falls back to the
 * email when there is none. So for someone who has not set a name, "name over
 * email" would render the same address twice — which reads as a rendering bug
 * rather than as missing data. `named` is what distinguishes the two cases, and
 * it comes from the server knowing whether the column was null, not from
 * comparing the two strings here: a person who literally sets their name to
 * their own address is entitled to see it once.
 *
 * The name is user-supplied text and is rendered as text. React escapes it, as
 * it does every string here — there is no `dangerouslySetInnerHTML` anywhere in
 * this codebase (CLAUDE.md rule 4), and a name is not the reason to add one.
 */
function PersonLine({
  person,
  suffix,
  online,
}: {
  readonly person: Person;
  readonly suffix?: string | null;
  readonly online?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="relative">
        <Avatar userId={person.userId} label={person.label} size="xs" />
        {online === true && (
          <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-success border-2 border-surface-raised" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm text-ink">
          {person.label}
          {suffix !== null && suffix !== undefined && (
            <span className="text-ink-faint">{suffix}</span>
          )}
        </span>
        {person.named && person.email !== null && (
          <span className="truncate text-xs text-ink-faint">{person.email}</span>
        )}
      </div>
    </div>
  );
}

function PanelHeader({ title, onClose }: { readonly title: string; readonly onClose: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close details"
        className="flex size-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink transition-colors"
      >
        <X className="size-4" />
      </button>
    </header>
  );
}

/**
 * The panel's own "who/what is this" header — the WhatsApp/Telegram "Group
 * info" shape: a large centered identity mark, the name, and a short line of
 * context, rather than the small left-aligned row this used to be.
 *
 * - A true 1:1 DM shows the OTHER PERSON's own avatar and name — the
 *   contact-info screen a real phone shows.  `MemberRoster` is skipped
 *   entirely for this case since there is nobody left to list.
 * - A group DM has no single identity to show, so it gets a generic
 *   people-mark instead, with the real roster in `MemberRoster`.
 * - An ordinary channel keeps its `#`/lock mark and adds the Edit
 *   control centered under the name.
 */
function IdentityHeader({
  orgId,
  data,
  viewerId,
  personOf,
  onlineUserIds,
  onEdit,
}: {
  readonly orgId: string;
  readonly data: ChannelDetail;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
  readonly onlineUserIds: ReadonlySet<string>;
  readonly onEdit: () => void;
}) {
  if (data.type === 'dm') {
    const others = data.memberIds.filter((userId) => userId !== viewerId);
    const only = others[0];
    if (only === undefined) {
      return <div className="border-b border-line px-4 pt-5 pb-5" />;
    }
    const person = personOf(only);

    return (
      <div className="flex flex-col items-center gap-1 border-b border-line px-4 pt-5 pb-5 text-center">
        <span className="relative inline-flex">
          <Avatar
            userId={person.userId}
            label={person.label}
            size="sm"
            className="size-12 text-base"
          />
          {onlineUserIds.has(only) && (
            <span
              aria-hidden="true"
              className="absolute right-0.5 bottom-0.5 size-3 rounded-full bg-success ring-2 ring-surface-raised"
            />
          )}
        </span>
        <p className="mt-2 text-base font-semibold text-ink">{person.label}</p>
        {person.named && person.email !== null && (
          <p className="text-xs text-ink-faint">{person.email}</p>
        )}
        <div className="mt-2">
          <DirectCallAction orgId={orgId} userId={only} />
        </div>
      </div>
    );
  }

  if (data.type === 'group_dm') {
    return (
      <div className="flex flex-col items-center gap-1 border-b border-line px-4 pt-5 pb-5 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-suite-chat/10 text-suite-chat">
          <Users aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </span>
        <p className="mt-2 text-base font-semibold text-ink">Group conversation</p>
        <p className="text-xs text-ink-faint">{data.memberIds.length} people</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1 border-b border-line px-4 pt-5 pb-5 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-suite-chat/10 text-suite-chat">
        {data.type === 'public' ? (
          <Hash aria-hidden="true" className="size-6" strokeWidth={1.75} />
        ) : (
          <Lock aria-hidden="true" className="size-6" strokeWidth={1.75} />
        )}
      </span>
      <p className="mt-2 max-w-full truncate text-base font-semibold text-ink">{data.name}</p>
      <p className="text-xs text-ink-faint">{data.memberIds.length} members</p>
      {data.topic !== null && <p className="max-w-xs text-xs text-ink-muted">{data.topic}</p>}
      {data.archivedAt !== null && (
        <p className="text-xs font-medium text-warning">
          Archived — no new messages can be posted.
        </p>
      )}
      <Button size="sm" variant="ghost" className="mt-1 gap-1" onClick={onEdit}>
        <Pencil aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Edit
      </Button>
    </div>
  );
}

/**
 * Click-to-call the other side of a 1:1 DM — PLAN.md §3.4's third named
 * surface ("from any card/contact/chat thread").
 *
 * Only for a two-person DM. A group conversation has no single callee, and
 * picking one for the caller would dial someone they did not choose.
 *
 * The number comes from the people directory rather than `useMembers`, whose
 * cache backs every avatar in the app and is deliberately narrow. Widening it
 * to carry a phone number would mean every board render holds one, for the
 * benefit of one panel.
 */
function DirectCallAction({ orgId, userId }: { readonly orgId: string; readonly userId: string }) {
  const member = useQuery({ ...directoryMemberQuery(orgId, userId), enabled: orgId !== '' });
  const workPhone = member.data?.workPhone ?? null;

  /* Silent when there is no number. This is an affordance, not a permission
     boundary — there is simply nothing to dial, and an explanatory empty state
     in a details panel would be noise on every DM in an org that has not filled
     the directory in. */
  if (workPhone === null) return null;

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] text-ink-muted">{workPhone}</span>
      <CallButton orgId={orgId} to={workPhone} />
    </div>
  );
}

function MemberRoster({
  memberIds,
  viewerId,
  personOf,
  removable,
  onRemove,
  onlineUserIds,
}: {
  readonly memberIds: readonly string[];
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
  readonly removable: boolean;
  readonly onRemove: (userId: UserId) => void;
  readonly onlineUserIds: Set<string>;
}) {
  const onlineCount = memberIds.filter((id) => onlineUserIds.has(id)).length;
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();

  const shown = memberIds.filter((userId) => {
    if (needle === '') return true;
    const person = personOf(userId);
    return (
      person.label.toLowerCase().includes(needle) ||
      person.email?.toLowerCase().includes(needle) === true
    );
  });

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Users className="size-3.5 text-ink-faint" />
        <h3 className="text-xs font-semibold text-ink-muted">
          Members · {memberIds.length}
          {onlineCount > 0 && <span className="text-success"> · {onlineCount} online</span>}
        </h3>
      </div>

      {memberIds.length === 0 ? (
        <Empty title="Nobody yet" description="This channel has no members." />
      ) : (
        <>
          {memberIds.length > 8 && (
            <Input
              id={`member-search`}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
              }}
              placeholder="Search members…"
              className="h-7 text-xs"
            />
          )}
          <ul className="flex flex-col gap-0.5">
            {shown.map((userId) => {
              const isViewer = userId === viewerId;
              const person = personOf(userId);
              return (
                <li
                  key={userId}
                  className="group flex items-center gap-2 rounded-md px-1 py-1 transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover"
                >
                  <PersonLine
                    person={person}
                    suffix={isViewer ? ' (you)' : null}
                    online={onlineUserIds.has(userId)}
                  />
                  {removable && (
                    <button
                      type="button"
                      onClick={() => {
                        onRemove(userId as UserId);
                      }}
                      className="shrink-0 rounded p-0.5 text-xs text-ink-faint opacity-0 hover:text-danger transition-all group-hover:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                      aria-label={isViewer ? 'Leave channel' : `Remove ${person.label}`}
                    >
                      {isViewer ? 'Leave' : 'Remove'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Add someone from the organization to this channel.
 *
 * The candidate list is `tenancy.members.list` minus whoever is already in —
 * filtered here rather than server-side because the roster is already loaded
 * and a second endpoint for "org members not in this channel" would be a query
 * whose only caller is this dropdown.
 *
 * A member who lacks `member:read` gets an empty list from that endpoint rather
 * than an error, which is why the empty state below says "nobody to add"
 * instead of implying a failure.
 */
function AddMemberControl({
  orgId,
  channelId,
  memberIds,
  onAdded,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly memberIds: readonly string[];
  readonly onAdded: () => void;
}) {
  const { people } = useMembers();
  const toast = useToast();
  const [query, setQuery] = useState('');

  const add = useMutation({
    mutationFn: (userId: UserId) => addChannelMember(channelId, userId),
    onSuccess: () => {
      setQuery('');
      onAdded();
    },
    onError: (error) => {
      toast.failure('They were not added', error);
    },
  });

  const inChannel = new Set(memberIds);
  const needle = query.trim().toLowerCase();
  const candidates = people
    .filter((member) => !inChannel.has(member.userId))
    .filter((member) => needle === '' || member.email.toLowerCase().includes(needle))
    .slice(0, 8);

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-xs font-semibold text-ink-muted">Add people</h3>

      <Field label="Search by email" htmlFor={`add-member-${orgId}`}>
        <Input
          id={`add-member-${orgId}`}
          value={query}
          placeholder="name@example.com"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </Field>

      {candidates.length === 0 ? (
        <p className="text-xs text-ink-faint">
          {needle === '' ? 'Everyone in the organization is already here.' : 'No match.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {candidates.map((member) => (
            <li key={member.userId}>
              <button
                type="button"
                disabled={add.isPending}
                onClick={() => {
                  add.mutate(member.userId as UserId);
                }}
                className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-surface-hover disabled:opacity-50"
              >
                <PersonLine
                  person={{
                    userId: member.userId,
                    label: member.displayName ?? member.email,
                    email: member.email,
                    named: member.displayName !== null,
                  }}
                />
                <span className="shrink-0 text-xs text-ink-faint">Add</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Invite or revoke a GUEST on this one channel (§3.8, §7.4).
 *
 * A guest is not a member: `setGuestAccess` marks the tuple `is_guest` for
 * access review and the server refuses it outright on anything that is not a
 * private channel (a guest in a public channel is a contradiction — public
 * already means readable by the org — and a guest can never reach a DM).
 * `ComplianceSection` only renders this for `channel.type === 'private'`,
 * for the same reason the roster hides Add/Remove on a DM: offering a
 * control whose only possible outcome is an error is worse than not
 * offering it.
 *
 * The candidate list is the same `tenancy.members.list` roster
 * `AddMemberControl` searches — a guest invite targets an existing account,
 * same as an ordinary member add; what makes it a GUEST grant is the
 * `is_guest` flag `setGuestAccess` sets, not who can be named.
 */
function GuestAccessSection({
  orgId,
  channelId,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
}) {
  const { people, personOf } = useMembers();
  const toast = useToast();
  const queryClient = useQueryClient();
  const guests = useQuery(guestsQuery(orgId, channelId));
  const [query, setQuery] = useState('');
  const [days, setDays] = useState('');

  const refresh = (): void => {
    invalidateChannelGuests(queryClient, orgId, channelId);
  };

  const invite = useMutation({
    mutationFn: (userId: UserId) =>
      setGuestAccess({
        channelId,
        userId,
        granted: true,
        /* Blank means no expiry — the server's own `expiresAt: null` default,
           never a client-chosen window a guest could outlive without anyone
           deciding that on purpose. */
        expiresAt:
          days.trim() === ''
            ? null
            : new Date(Date.now() + Number.parseInt(days, 10) * 86_400_000).toISOString(),
      }),
    onSuccess: () => {
      setQuery('');
      refresh();
    },
    onError: (error) => {
      toast.failure('They were not invited', error);
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: UserId) =>
      setGuestAccess({ channelId, userId, granted: false, expiresAt: null }),
    onSuccess: refresh,
    onError: (error) => {
      toast.failure('Access was not revoked', error);
    },
  });

  const guestIds = new Set((guests.data ?? []).map((row) => row.userId));
  const needle = query.trim().toLowerCase();
  const candidates = people
    .filter((member) => !guestIds.has(member.userId))
    .filter((member) => needle === '' || member.email.toLowerCase().includes(needle))
    .slice(0, 8);

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-xs font-semibold text-ink-muted">Guest access</h3>
      <p className="text-xs text-ink-faint">
        A guest can read and post in this one channel — nothing else in the organization.
      </p>

      {(guests.data ?? []).length > 0 && (
        <ul className="flex flex-col gap-1">
          {guests.data?.map((row) => (
            <GuestRow
              key={row.userId}
              row={row}
              personOf={personOf}
              pending={revoke.isPending}
              onRevoke={() => {
                revoke.mutate(row.userId as UserId);
              }}
            />
          ))}
        </ul>
      )}

      <Field label="Invite by email" htmlFor={`guest-invite-${channelId}`}>
        <Input
          id={`guest-invite-${channelId}`}
          value={query}
          placeholder="name@example.com"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </Field>

      {needle !== '' &&
        (candidates.length === 0 ? (
          <p className="text-xs text-ink-faint">No match.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {candidates.map((member) => (
              <li key={member.userId}>
                <button
                  type="button"
                  disabled={invite.isPending}
                  onClick={() => {
                    invite.mutate(member.userId as UserId);
                  }}
                  className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-surface-hover disabled:opacity-50"
                >
                  <PersonLine
                    person={{
                      userId: member.userId,
                      label: member.displayName ?? member.email,
                      email: member.email,
                      named: member.displayName !== null,
                    }}
                  />
                  <span className="shrink-0 text-xs text-ink-faint">Invite</span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      <Field label="Access expires after (days, optional)" htmlFor={`guest-expiry-${channelId}`}>
        <Input
          id={`guest-expiry-${channelId}`}
          inputMode="numeric"
          value={days}
          placeholder="Never"
          onChange={(event) => {
            setDays(event.target.value.replace(/[^0-9]/g, ''));
          }}
        />
      </Field>
    </section>
  );
}

function GuestRow({
  row,
  personOf,
  pending,
  onRevoke,
}: {
  readonly row: ChannelGuestRow;
  readonly personOf: (userId: string) => Person;
  readonly pending: boolean;
  readonly onRevoke: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2">
      <PersonLine
        person={personOf(row.userId)}
        suffix={
          row.expiresAt === null ? null : ` — until ${new Date(row.expiresAt).toLocaleDateString()}`
        }
      />
      <Button size="sm" variant="ghost" disabled={pending} onClick={onRevoke}>
        Revoke
      </Button>
    </li>
  );
}

/**
 * Rename / re-topic.
 *
 * A full replace of both fields — safe here in a way `cards.update` is not,
 * because this form holds every field the channel has. There is no hidden
 * value for a summary-shaped write to erase.
 */
function ChannelSettingsForm({
  orgId,
  channelId,
  name,
  topic,
  onDone,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly name: string;
  readonly topic: string | null;
  readonly onDone: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draftName, setDraftName] = useState(name);
  const [draftTopic, setDraftTopic] = useState(topic ?? '');

  const save = useMutation({
    mutationFn: () =>
      updateChannel({
        channelId,
        name: draftName,
        /* An empty box means "no topic", which is null — not the empty string.
           Storing '' would make "has a topic" true for a channel whose topic
           renders as nothing. */
        topic: draftTopic.trim() === '' ? null : draftTopic.trim(),
      }),
    onSuccess: () => {
      invalidateChannel(queryClient, orgId, channelId);
      invalidateChannels(queryClient, orgId);
      onDone();
    },
    onError: (error) => {
      toast.failure('The channel was not saved', error);
    },
  });

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name" htmlFor="channel-name">
        <Input
          id="channel-name"
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value);
          }}
        />
      </Field>

      <Field label="Topic" htmlFor="channel-topic">
        <Input
          id="channel-topic"
          value={draftTopic}
          placeholder="What is this channel for?"
          onChange={(event) => {
            setDraftTopic(event.target.value);
          }}
        />
      </Field>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || draftName.trim() === ''}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Retention, legal hold, guests and export (Wave 4, §3.7, §3.8).
 *
 * ## Rendered only when the server says `manage`
 *
 * This is the one place in the chat UI that hides a whole section rather than
 * letting the server refuse, and the reason is not "these are dangerous". It is
 * that `capabilities.manage` comes FROM the server, computed by the same `can()`
 * that enforces — so hiding it is displaying the server's answer, not the
 * client reaching its own. §8.2's rule is against a second authorization model;
 * showing what the first one decided is the opposite of that.
 *
 * ## What each control actually does, and why the wording matters
 *
 * A retention window DELETES messages on a schedule, and shortening one takes
 * effect on the next sweep with no further confirmation. A legal hold exempts
 * messages from that. Both are stated in those terms rather than as "settings",
 * because the failure mode of a vague label here is somebody discarding a
 * year of a team's conversation while believing they adjusted a preference.
 */
function ComplianceSection({
  orgId,
  channelId,
  channel,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly channel: ChannelDetail;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(
    channel.retentionDays === null ? '' : String(channel.retentionDays),
  );

  const refresh = (): void => {
    invalidateChannel(queryClient, orgId, channelId);
  };

  const retention = useMutation({
    mutationFn: () =>
      setRetention({
        channelId,
        /* An empty box means KEEP FOREVER, which is null — never a default
           number. A default retention window living in the client would start
           deleting messages the day somebody changed the constant. */
        retentionDays: days.trim() === '' ? null : Number.parseInt(days, 10),
      }),
    onSuccess: (result) => {
      refresh();
      toast.show(
        result.retentionDays === null
          ? 'Messages in this channel are kept indefinitely'
          : `Messages older than ${String(result.retentionDays)} days will be deleted`,
      );
    },
    onError: (error) => {
      toast.failure('The retention policy was not saved', error);
    },
  });

  const hold = useMutation({
    mutationFn: (held: boolean) => holdChannel({ channelId, held }),
    onSuccess: (result) => {
      refresh();
      toast.show(
        result.held
          ? 'Legal hold placed — retention will not delete anything here'
          : 'Legal hold lifted — retention applies again',
      );
    },
    onError: (error) => {
      toast.failure('The legal hold was not changed', error);
    },
  });

  const exportChannelMutation = useMutation({
    mutationFn: () => exportChannel({ channelId, includeDeleted: true }),
    onSuccess: (result) => {
      /* Downloaded as a file the browser builds from the response, never a link
         the server hands out: an export is the entire contents of a private
         conversation, and a URL to it would be a second copy living somewhere
         the audit trail says nothing about. `compliance.exported` has already
         recorded that this happened. */
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${result.channelName ?? 'channel'}-export.json`;
      anchor.click();
      URL.revokeObjectURL(url);

      toast.show(`Exported ${String(result.messages.length)} messages`);
    },
    onError: (error) => {
      toast.failure('The export failed', error);
    },
  });

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-3">
      <h3 className="text-xs font-semibold text-ink-muted">Retention &amp; compliance</h3>

      <Field label="Delete messages older than (days)" htmlFor="retention-days">
        <div className="flex gap-2">
          <Input
            id="retention-days"
            inputMode="numeric"
            value={days}
            placeholder="Never"
            onChange={(event) => {
              setDays(event.target.value.replace(/[^0-9]/g, ''));
            }}
          />
          <Button
            size="sm"
            disabled={retention.isPending}
            onClick={() => {
              retention.mutate();
            }}
          >
            Save
          </Button>
        </div>
      </Field>
      <p className="text-xs text-ink-faint">
        Leave blank to keep messages indefinitely. Deletions are recorded in the audit log.
      </p>

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Legal hold</span>
          <span className="text-xs text-ink-faint">
            {channel.retentionHold
              ? 'On — nothing here will be deleted by retention'
              : 'Off — the retention policy above applies'}
          </span>
        </div>
        <Button
          size="sm"
          variant={channel.retentionHold ? 'primary' : 'ghost'}
          disabled={hold.isPending}
          onClick={() => {
            hold.mutate(!channel.retentionHold);
          }}
        >
          {channel.retentionHold ? 'Lift' : 'Place'}
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Export conversation</span>
          <span className="text-xs text-ink-faint">
            Every message, including deleted ones. This export is audited.
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={exportChannelMutation.isPending}
          onClick={() => {
            exportChannelMutation.mutate();
          }}
        >
          Export
        </Button>
      </div>
    </section>
  );
}

/**
 * `ComplianceSection` renders retention/hold/export for every non-DM channel
 * `capabilities.manage` allows — but a guest can only ever be invited to a
 * PRIVATE one (`setGuestAccess` refuses `public`, `dm` and `group_dm`
 * outright). The type check here is the same "do not offer a button whose
 * only possible outcome is an error" rule `ChannelDetailsPanel` already
 * applies to Add/Remove on a DM — a product fact about channel shape, not a
 * permission this component is re-deriving.
 */
function ComplianceAndGuests({
  orgId,
  channelId,
  channel,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly channel: ChannelDetail;
}) {
  return (
    <>
      <ComplianceSection orgId={orgId} channelId={channelId} channel={channel} />
      {channel.type === 'private' && <GuestAccessSection orgId={orgId} channelId={channelId} />}
    </>
  );
}
