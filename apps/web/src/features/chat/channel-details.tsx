import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelId, UserId } from '@taskflow/contracts';
import { cn } from '../../lib/cn.js';
import { useSession } from '../../lib/session.js';
import { useToast } from '../../lib/toast-context.js';
import { Avatar, Button, ConfirmButton, Empty, Field, Input } from '../../components/primitives.js';
import { useMembers, type Person } from '../org/use-members.js';
import {
  addChannelMember,
  exportChannel,
  holdChannel,
  setRetention,
  type ChannelDetail,
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
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly onClose: () => void;
}) {
  const channel = useQuery(channelQuery(orgId, channelId));
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editingSettings, setEditingSettings] = useState(false);

  const data = channel.data;
  const isDirect = data?.type === 'dm' || data?.type === 'group_dm';

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

  if (data === undefined) {
    return (
      <aside className="flex w-72 shrink-0 flex-col border-l border-line">
        <PanelHeader title="Details" onClose={onClose} />
      </aside>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line">
      <PanelHeader title="Details" onClose={onClose} />

      <div className="flex flex-col gap-4 p-4">
        {isDirect ? (
          <DirectMessageIdentity
            memberIds={data.memberIds}
            viewerId={viewerId}
            personOf={personOf}
          />
        ) : editingSettings ? (
          <ChannelSettingsForm
            orgId={orgId}
            channelId={channelId}
            name={data.name ?? ''}
            topic={data.topic}
            onDone={() => {
              setEditingSettings(false);
            }}
          />
        ) : (
          <section className="flex flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-ink">
                {data.type === 'public' ? '# ' : '🔒 '}
                {data.name}
              </h3>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingSettings(true);
                }}
              >
                Edit
              </Button>
            </div>
            <p className={cn('text-xs', data.topic === null ? 'text-ink-faint' : 'text-ink-muted')}>
              {data.topic ?? 'No topic set.'}
            </p>
            {data.archivedAt !== null && (
              <p className="text-xs font-medium text-warning">
                Archived — no new messages can be posted.
              </p>
            )}
          </section>
        )}

        <MemberRoster
          memberIds={data.memberIds}
          viewerId={viewerId}
          personOf={personOf}
          /* A DM's roster is informational: the service refuses both add and
             remove on one, so a control here could only ever produce an error. */
          removable={!isDirect}
          onRemove={(userId) => {
            remove.mutate(userId);
          }}
        />

        {!isDirect && (
          <AddMemberControl
            orgId={orgId}
            channelId={channelId}
            memberIds={data.memberIds}
            onAdded={refresh}
          />
        )}

        {!isDirect && data.capabilities.manage && (
          <ComplianceSection orgId={orgId} channelId={channelId} channel={data} />
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
}: {
  readonly person: Person;
  readonly suffix?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Avatar userId={person.userId} label={person.label} size="xs" />
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
      <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close details">
        ✕
      </Button>
    </header>
  );
}

/**
 * Who you are talking to, for a DM.
 *
 * ## Only an email, and that is not a shortcut
 *
 * `identity.users` has no display-name column — `useMembers`' own `Person.label`
 * records this as "Email today. Becomes a display name when there is a profile
 * surface." So a two-line "name over email" treatment would render the address
 * twice, which reads as a rendering bug rather than as missing data. One line,
 * honestly labelled, until there is a second field to show.
 *
 * A group DM lists everyone except the viewer: "you and three others" is what
 * the sidebar shows, and the panel is where the actual names belong.
 */
function DirectMessageIdentity({
  memberIds,
  viewerId,
  personOf,
}: {
  readonly memberIds: readonly string[];
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
}) {
  const others = memberIds.filter((userId) => userId !== viewerId);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
        {others.length === 1 ? 'Direct message with' : 'Group conversation'}
      </h3>
      {others.map((userId) => (
        <PersonLine key={userId} person={personOf(userId)} />
      ))}
    </section>
  );
}

function MemberRoster({
  memberIds,
  viewerId,
  personOf,
  removable,
  onRemove,
}: {
  readonly memberIds: readonly string[];
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
  readonly removable: boolean;
  readonly onRemove: (userId: UserId) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
        Members · {memberIds.length}
      </h3>

      {memberIds.length === 0 ? (
        <Empty title="Nobody yet" description="This channel has no members." />
      ) : (
        <ul className="flex flex-col gap-1">
          {memberIds.map((userId) => {
            const isViewer = userId === viewerId;
            return (
              <li key={userId} className="flex items-center gap-2">
                <PersonLine person={personOf(userId)} suffix={isViewer ? ' (you)' : null} />
                {removable && (
                  /* One route, two labels. `removeMember` is the same call
                     either way — the service decides that leaving needs only
                     `channel:read` while removing somebody else needs
                     `channel:manage`. The wording here follows the target, not
                     the permission, because the client knows the target for
                     certain and knows the permission not at all. */
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-xs"
                    onClick={() => {
                      onRemove(userId as UserId);
                    }}
                  >
                    {isViewer ? 'Leave' : 'Remove'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
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
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">Add people</h3>

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
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
        Retention &amp; compliance
      </h3>

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
