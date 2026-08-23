import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { ChannelIdSchema, type ChannelId } from '@taskflow/contracts';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { useMembers, type Person } from '../../../src/lib/use-members.js';
import {
  callHistoryQueryKey,
  formatCallDuration,
  type CallHistoryEntry,
} from '../../../src/lib/rtc.js';
import {
  CHANNELS_QUERY_KEY,
  channelQueryKey,
  filesQueryKey,
  guestsQueryKey,
  pinsQueryKey,
  SAVED_QUERY_KEY,
  type ChannelDetail,
  type ChannelFile,
  type ChannelGuest,
  type PinnedMessage,
  type SavedMessage,
} from '../../../src/lib/chat.js';

/**
 * A channel's Details screen — the gap a second real device review named
 * directly: "where to see details like what we do by clicking the chat
 * header to see members and all this info and where to add members." Ported
 * feature-for-feature from `apps/web/src/features/chat/channel-details.tsx`
 * (the user's own choice, offered explicitly against a narrower "roster +
 * settings only" cut): roster, add/remove, rename/topic, pinned, starred
 * (saved), files, guest access, retention/legal-hold/export, and
 * archive/restore. A full-screen route (`router.push`), not a bottom-sheet
 * `Modal` like this app's other secondary flows — web's own panel already
 * becomes "a full-width overlay on top of the conversation" below its `md`
 * breakpoint, i.e. at phone width, which is a router push in a navigator
 * that has no side-panel concept at all.
 *
 * **In-app calling has a real call-history list here (`CallHistorySection`,
 * below) — the "Call"/"Join call" button itself lives one screen up, in
 * `channel/[channelId].tsx`'s own header, not here.** This paragraph
 * originally excluded BOTH, on the reasoning that "Phase 13's WebRTC
 * signaling lives only in `apps/web`" — true when this screen first
 * shipped, no longer true once `apps/mobile` grew its own signaling stack
 * (`rtc-socket.ts`, `peer-mesh.ts`, `use-call.ts`, `call-surface.tsx` —
 * Phase 13, Wave 5 here). Left corrected in place rather than silently
 * rewritten, the same "a status marker is a claim, not a fact" habit
 * CLAUDE.md documents.
 *
 * **Still genuinely excluded: `DirectCallAction`**, web's click-to-call
 * button for a two-person DM's counterparty WORK PHONE — a Phase 7
 * (Twilio/PSTN) telephony affordance, not Phase 13's in-app WebRTC calling.
 * "Phase 7's telephony client has never been ported to `apps/mobile` at
 * all" was true when this paragraph was written; `(tabs)/calls.tsx` is that
 * port now, and `telephony-call-button.tsx`'s `TelephonyCallButton` is the
 * exact component `DirectCallAction` would reuse. Still not wired in HERE,
 * though — adding it to this screen is its own small follow-up, not
 * something the telephony port did on its way past. The two are easy to
 * conflate because both put a phone icon near a DM's header; they dial
 * through entirely different systems (a real PSTN number vs. this app's own
 * signaling gateway), and only the second one exists on this specific
 * screen today.
 *
 * **Every control here is shown; the server decides** — the same rule
 * `channel-details.tsx`'s own header states for web, restated because this
 * screen is a direct port of it: no `role === 'admin'`, no client-computed
 * "can I manage this channel" anywhere below. Rename/Archive/Remove read
 * `channel.data.capabilities.manage`; compliance and guest access are the
 * one exception that HIDES rather than shows-and-lets-the-server-refuse
 * (matching web exactly, for the identical reason web's header gives:
 * hiding a section gated on the server's own `capabilities.manage` is
 * displaying that decision, not a second one).
 */
export default function ChannelDetailsScreen() {
  const params = useLocalSearchParams<{ channelId: string }>();
  const parsedChannelId = ChannelIdSchema.safeParse(params.channelId);

  if (!parsedChannelId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This channel link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return <ChannelDetailsContent channelId={parsedChannelId.data} />;
}

function ChannelDetailsContent({ channelId }: { channelId: ChannelId }) {
  const queryClient = useQueryClient();
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const paddingTop = useTopInset();

  const channel = useQuery({
    queryKey: channelQueryKey(channelId),
    queryFn: () => apiClient.chat.channels.get.query({ channelId }),
  });
  const data = channel.data;
  const isDirect = data?.type === 'dm' || data?.type === 'group_dm';
  const canManage = data?.capabilities.manage === true;

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: channelQueryKey(channelId) }),
      queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }),
    ]);
  };

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      apiClient.chat.channels.removeMember.mutate({ channelId, userId: userId }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: () =>
      apiClient.chat.channels.archive.mutate({
        channelId,
        restored: data?.archivedAt !== null,
      }),
    onSuccess: refresh,
  });

  if (channel.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(channel.error)?.error.message ?? "Couldn't load this channel."}
        </Text>
        <BackButton />
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { paddingTop }]} contentContainerStyle={styles.content}>
      <BackButton />
      <Text style={styles.screenTitle}>Details</Text>

      {data === undefined ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : (
        <>
          {isDirect ? (
            <DirectMessageIdentity channel={data} viewerId={viewerId} personOf={personOf} />
          ) : (
            <ChannelIdentity channelId={channelId} channel={data} onSaved={refresh} />
          )}

          <MemberRoster
            memberIds={data.memberIds}
            viewerId={viewerId}
            personOf={personOf}
            removable={!isDirect}
            pending={removeMember.isPending}
            onRemove={(userId) => {
              removeMember.mutate(userId);
            }}
          />

          {!isDirect && (
            <AddMemberControl channelId={channelId} memberIds={data.memberIds} onAdded={refresh} />
          )}

          <PinnedSection channelId={channelId} personOf={personOf} />
          <SavedSection channelId={channelId} />
          <FilesSection channelId={channelId} />
          <CallHistorySection channelId={channelId} personOf={personOf} />

          {!isDirect && data.type === 'private' && canManage && (
            <GuestAccessSection channelId={channelId} />
          )}

          {!isDirect && canManage && <ComplianceSection channelId={channelId} channel={data} />}

          {!isDirect && (
            <View style={styles.archiveSection}>
              <Pressable
                style={styles.archiveButton}
                disabled={archive.isPending}
                onPress={() => {
                  archive.mutate();
                }}
              >
                <Text style={styles.archiveButtonText}>
                  {data.archivedAt === null ? 'Archive channel' : 'Restore channel'}
                </Text>
              </Pressable>
              {archive.isError && (
                <Text style={styles.sectionError} accessibilityRole="alert">
                  {apiErrorOf(archive.error)?.error.message ?? 'The channel could not be archived.'}
                </Text>
              )}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

/** Who you are talking to, for a DM — the header title's own participant lookup, restated as full rows. */
function DirectMessageIdentity({
  channel,
  viewerId,
  personOf,
}: {
  readonly channel: ChannelDetail;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
}) {
  const others = channel.memberIds.filter((userId) => userId !== viewerId);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {others.length === 1 ? 'Direct message with' : 'Group conversation'}
      </Text>
      {others.map((userId) => (
        <PersonLine key={userId} person={personOf(userId)} />
      ))}
    </View>
  );
}

/** A channel's name/topic, with an inline rename form gated on `capabilities.manage`. */
function ChannelIdentity({
  channelId,
  channel,
  onSaved,
}: {
  readonly channelId: ChannelId;
  readonly channel: ChannelDetail;
  readonly onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(channel.name ?? '');
  const [draftTopic, setDraftTopic] = useState(channel.topic ?? '');

  const save = useMutation({
    mutationFn: () =>
      apiClient.chat.channels.update.mutate({
        channelId,
        name: draftName.trim(),
        topic: draftTopic.trim() === '' ? null : draftTopic.trim(),
      }),
    onSuccess: async () => {
      setEditing(false);
      await onSaved();
    },
  });

  if (editing) {
    return (
      <View style={styles.section}>
        <TextInput
          value={draftName}
          onChangeText={setDraftName}
          placeholder="Channel name"
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.formInput}
        />
        <TextInput
          value={draftTopic}
          onChangeText={setDraftTopic}
          placeholder="What is this channel for?"
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.formInput}
        />
        {save.isError && (
          <Text style={styles.sectionError} accessibilityRole="alert">
            {apiErrorOf(save.error)?.error.message ?? 'The channel could not be saved.'}
          </Text>
        )}
        <View style={styles.formActions}>
          <Pressable
            style={[
              styles.formSubmit,
              (save.isPending || draftName.trim() === '') && styles.formSubmitDisabled,
            ]}
            disabled={save.isPending || draftName.trim() === ''}
            onPress={() => {
              save.mutate();
            }}
          >
            {save.isPending ? (
              <ActivityIndicator color={colors.accentInk.hex} />
            ) : (
              <Text style={styles.formSubmitText}>Save</Text>
            )}
          </Pressable>
          <Pressable
            style={styles.modalCancel}
            onPress={() => {
              setEditing(false);
            }}
          >
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.identityRow}>
        <Text style={styles.identityName}>
          {channel.type === 'public' ? '# ' : '🔒 '}
          {channel.name}
        </Text>
        {channel.capabilities.manage && (
          <Pressable
            onPress={() => {
              setEditing(true);
            }}
          >
            <Text style={styles.editLink}>Edit</Text>
          </Pressable>
        )}
      </View>
      <Text style={channel.topic === null ? styles.identityTopicEmpty : styles.identityTopic}>
        {channel.topic ?? 'No topic set.'}
      </Text>
      {channel.archivedAt !== null && (
        <Text style={styles.archivedNotice}>Archived — no new messages can be posted.</Text>
      )}
    </View>
  );
}

function PersonLine({
  person,
  suffix,
}: {
  readonly person: Person;
  readonly suffix?: string | undefined;
}) {
  return (
    <View style={styles.personLine}>
      <View style={styles.avatarSmall}>
        <Text style={styles.avatarSmallText}>{person.label.slice(0, 1).toUpperCase()}</Text>
      </View>
      <Text style={styles.personLabel} numberOfLines={1}>
        {person.label}
        {suffix !== undefined && <Text style={styles.personSuffix}>{suffix}</Text>}
      </Text>
    </View>
  );
}

function MemberRoster({
  memberIds,
  viewerId,
  personOf,
  removable,
  pending,
  onRemove,
}: {
  readonly memberIds: readonly string[];
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
  readonly removable: boolean;
  readonly pending: boolean;
  readonly onRemove: (userId: string) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Members · {memberIds.length}</Text>
      {memberIds.length === 0 ? (
        <Text style={styles.sectionEmpty}>This channel has no members.</Text>
      ) : (
        memberIds.map((userId) => {
          const isViewer = userId === viewerId;
          return (
            <View key={userId} style={styles.rosterRow}>
              <PersonLine person={personOf(userId)} suffix={isViewer ? ' (you)' : undefined} />
              {removable && (
                <Pressable
                  disabled={pending}
                  onPress={() => {
                    onRemove(userId);
                  }}
                >
                  <Text style={styles.rosterAction}>{isViewer ? 'Leave' : 'Remove'}</Text>
                </Pressable>
              )}
            </View>
          );
        })
      )}
    </View>
  );
}

/** Search by email, mirroring `apps/web`'s own `AddMemberControl` exactly — a product choice, not a mobile shortcut. */
function AddMemberControl({
  channelId,
  memberIds,
  onAdded,
}: {
  readonly channelId: ChannelId;
  readonly memberIds: readonly string[];
  readonly onAdded: () => Promise<void>;
}) {
  const { people } = useMembers();
  const [query, setQuery] = useState('');

  const add = useMutation({
    mutationFn: (userId: string) =>
      apiClient.chat.channels.addMember.mutate({ channelId, userId: userId }),
    onSuccess: async () => {
      setQuery('');
      await onAdded();
    },
  });

  const inChannel = new Set(memberIds);
  const needle = query.trim().toLowerCase();
  const candidates = people
    .filter((member) => !inChannel.has(member.userId))
    .filter((member) => needle === '' || member.email.toLowerCase().includes(needle))
    .slice(0, 8);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Add people</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by email"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
        autoCapitalize="none"
      />
      {candidates.length === 0 ? (
        <Text style={styles.sectionEmpty}>
          {needle === '' ? 'Everyone in the organization is already here.' : 'No match.'}
        </Text>
      ) : (
        candidates.map((member) => (
          <Pressable
            key={member.userId}
            style={styles.rosterRow}
            disabled={add.isPending}
            onPress={() => {
              add.mutate(member.userId);
            }}
          >
            <PersonLine
              person={{
                userId: member.userId,
                label: member.displayName ?? member.email,
                named: member.displayName !== null,
              }}
            />
            <Text style={styles.rosterAction}>Add</Text>
          </Pressable>
        ))
      )}
      {add.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(add.error)?.error.message ?? 'They could not be added.'}
        </Text>
      )}
    </View>
  );
}

function ExcerptRow({
  excerpt,
  meta,
  actionLabel,
  actionPending,
  onAction,
}: {
  readonly excerpt: string | null;
  readonly meta: string;
  readonly actionLabel: string;
  readonly actionPending: boolean;
  readonly onAction: () => void;
}) {
  return (
    <View style={styles.excerptRow}>
      <View style={styles.excerptBody}>
        <Text
          style={excerpt === null ? styles.excerptDeleted : styles.excerptText}
          numberOfLines={2}
        >
          {excerpt ?? 'Message deleted'}
        </Text>
        <Text style={styles.excerptMeta}>{meta}</Text>
      </View>
      <Pressable disabled={actionPending} onPress={onAction}>
        <Text style={styles.rosterAction}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

/**
 * Every call this conversation has had, newest first — closes §6's "no
 * listing UI" gap for mobile, the same read `apps/web`'s Calls tab uses
 * (`rtc.history.list`, `channel:read`, not a narrower "was I on this
 * call" check — see that route's own header). No recording listing/
 * playback here: `use-call.ts`'s own header is why mobile never captures
 * one, so there is nothing of this app's own making to browse; a
 * recording captured by a web participant is a real, separate surface
 * this increment does not add.
 */
function CallHistorySection({
  channelId,
  personOf,
}: {
  readonly channelId: ChannelId;
  readonly personOf: (userId: string) => Person;
}) {
  const orgId = useSession((state) => state.orgId);
  const history = useQuery({
    queryKey: callHistoryQueryKey(orgId ?? '', channelId),
    queryFn: async () => wire(await apiClient.rtc.history.list.query({ channelId })),
    enabled: orgId !== null,
  });

  const rows: readonly CallHistoryEntry[] = history.data ?? [];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Calls · {rows.length}</Text>
      {rows.length === 0 ? (
        <Text style={styles.sectionEmpty}>No calls in this conversation yet.</Text>
      ) : (
        rows.map((row) => (
          <View key={row.sessionId} style={styles.excerptRow}>
            <View style={styles.excerptBody}>
              <Text style={styles.excerptText}>📞 {personOf(row.initiatedBy).label}</Text>
              <Text style={styles.excerptMeta}>{callOutcomeLabel(row)}</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

/** What a call history row's own line reads — a duration when the call
    actually connected, otherwise the reason it did not. */
function callOutcomeLabel(row: CallHistoryEntry): string {
  if (row.startedAt !== null && row.endedAt !== null) {
    const seconds = Math.max(
      0,
      Math.round((new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()) / 1000),
    );
    return formatCallDuration(seconds);
  }
  if (row.status === 'ringing') return 'Ringing…';
  switch (row.endReason) {
    case 'declined':
      return 'Declined';
    case 'no_answer':
      return 'No answer';
    case 'cancelled':
      return 'Cancelled';
    case null:
      return 'Ended';
    default:
      return row.endReason;
  }
}

function PinnedSection({
  channelId,
  personOf,
}: {
  readonly channelId: ChannelId;
  readonly personOf: (userId: string) => Person;
}) {
  const queryClient = useQueryClient();
  const pins = useQuery({
    queryKey: pinsQueryKey(channelId),
    queryFn: () => apiClient.chat.messages.pins.query({ channelId }),
  });

  const unpin = useMutation({
    mutationFn: (messageId: string) =>
      apiClient.chat.messages.unpin.mutate({ channelId, messageId: messageId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pinsQueryKey(channelId) });
    },
  });

  const rows: readonly PinnedMessage[] = pins.data ?? [];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Pinned · {rows.length}</Text>
      {rows.length === 0 ? (
        <Text style={styles.sectionEmpty}>Nothing pinned in this conversation.</Text>
      ) : (
        rows.map((row) => (
          <ExcerptRow
            key={row.messageId}
            excerpt={row.excerpt}
            meta={`Pinned by ${row.pinnedBy === null ? 'someone who has left' : personOf(row.pinnedBy).label}`}
            actionLabel="Unpin"
            actionPending={unpin.isPending}
            onAction={() => {
              unpin.mutate(row.messageId);
            }}
          />
        ))
      )}
    </View>
  );
}

/** `chat.saved.list` is org-wide (a save is personal) — filtered here to this one channel, matching `apps/web`'s own `SavedSection`. */
function SavedSection({ channelId }: { readonly channelId: ChannelId }) {
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: SAVED_QUERY_KEY,
    queryFn: () => apiClient.chat.saved.list.query(),
  });

  const unsave = useMutation({
    mutationFn: (messageId: string) => apiClient.chat.saved.unsave.mutate({ messageId: messageId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SAVED_QUERY_KEY });
    },
  });

  const inThisChannel: readonly SavedMessage[] = (saved.data ?? []).filter(
    (row) => row.channelId === channelId,
  );

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Starred by you · {inThisChannel.length}</Text>
      {inThisChannel.length === 0 ? (
        <Text style={styles.sectionEmpty}>
          Star a message in this conversation to keep it for later.
        </Text>
      ) : (
        inThisChannel.map((row) => (
          <ExcerptRow
            key={row.messageId}
            excerpt={row.excerpt}
            meta="Starred"
            actionLabel="★"
            actionPending={unsave.isPending}
            onAction={() => {
              unsave.mutate(row.messageId);
            }}
          />
        ))
      )}
    </View>
  );
}

/**
 * Every live attachment this conversation has ever held. Download only —
 * attaching a NEW file from the composer is real, separate work (an image
 * picker, an upload flow, virus-scan status polling), the same boundary
 * `channel/[channelId].tsx`'s own header now draws explicitly.
 *
 * `Linking.openURL`, not a fetch: the presigned URL is single-use and
 * short-lived, and the device's own browser/downloader is what actually
 * saves the file — the same primitive `rich-text-view.tsx` already uses for
 * a link mark, reused here rather than adding a download library.
 */
function FilesSection({ channelId }: { readonly channelId: ChannelId }) {
  const files = useQuery({
    queryKey: filesQueryKey(channelId),
    queryFn: () => apiClient.chat.attachments.listForChannel.query({ channelId }),
  });

  const download = useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.chat.attachments.download.mutate({ attachmentId: attachmentId }),
    onSuccess: (result) => {
      void Linking.openURL(result.url);
    },
  });

  const rows: readonly ChannelFile[] = files.data ?? [];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Files · {rows.length}</Text>
      {rows.length === 0 ? (
        <Text style={styles.sectionEmpty}>Files shared in this conversation appear here.</Text>
      ) : (
        rows.map((file) => (
          <View key={file.attachmentId} style={styles.rosterRow}>
            <Text style={styles.fileName} numberOfLines={1}>
              📎 {file.filename}
            </Text>
            {file.status === 'clean' ? (
              <Pressable
                disabled={download.isPending}
                onPress={() => {
                  download.mutate(file.attachmentId);
                }}
              >
                <Text style={styles.rosterAction}>Download</Text>
              </Pressable>
            ) : (
              <Text style={styles.fileStatus}>
                {file.status === 'infected'
                  ? 'Blocked'
                  : file.status === 'rejected'
                    ? 'Rejected'
                    : 'Scanning…'}
              </Text>
            )}
          </View>
        ))
      )}
      {download.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(download.error)?.error.message ?? 'That file could not be downloaded.'}
        </Text>
      )}
    </View>
  );
}

/** Invite or revoke a guest on this one PRIVATE channel — only ever rendered for `type === 'private'` (see this file's own header). */
function GuestAccessSection({ channelId }: { readonly channelId: ChannelId }) {
  const { people, personOf } = useMembers();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [days, setDays] = useState('');

  const guests = useQuery({
    queryKey: guestsQueryKey(channelId),
    queryFn: () => apiClient.chat.compliance.listGuests.query({ channelId }),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: guestsQueryKey(channelId) });
  };

  const invite = useMutation({
    mutationFn: (userId: string) =>
      apiClient.chat.compliance.setGuest.mutate({
        channelId,
        userId: userId,
        granted: true,
        expiresAt:
          days.trim() === ''
            ? null
            : new Date(Date.now() + Number.parseInt(days, 10) * 86_400_000).toISOString(),
      }),
    onSuccess: async () => {
      setQuery('');
      await refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: string) =>
      apiClient.chat.compliance.setGuest.mutate({
        channelId,
        userId: userId,
        granted: false,
        expiresAt: null,
      }),
    onSuccess: refresh,
  });

  const rows: readonly ChannelGuest[] = guests.data ?? [];
  const guestIds = new Set(rows.map((row) => row.userId));
  const needle = query.trim().toLowerCase();
  const candidates = people
    .filter((member) => !guestIds.has(member.userId))
    .filter((member) => needle === '' || member.email.toLowerCase().includes(needle))
    .slice(0, 8);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Guest access</Text>
      <Text style={styles.sectionHint}>
        A guest can read and post in this one channel — nothing else in the organization.
      </Text>

      {rows.map((row) => (
        <View key={row.userId} style={styles.rosterRow}>
          <PersonLine
            person={personOf(row.userId)}
            suffix={
              row.expiresAt === null
                ? undefined
                : ` — until ${new Date(row.expiresAt).toLocaleDateString()}`
            }
          />
          <Pressable
            disabled={revoke.isPending}
            onPress={() => {
              revoke.mutate(row.userId);
            }}
          >
            <Text style={styles.rosterAction}>Revoke</Text>
          </Pressable>
        </View>
      ))}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Invite by email"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
        autoCapitalize="none"
      />
      {needle !== '' &&
        (candidates.length === 0 ? (
          <Text style={styles.sectionEmpty}>No match.</Text>
        ) : (
          candidates.map((member) => (
            <Pressable
              key={member.userId}
              style={styles.rosterRow}
              disabled={invite.isPending}
              onPress={() => {
                invite.mutate(member.userId);
              }}
            >
              <PersonLine
                person={{
                  userId: member.userId,
                  label: member.displayName ?? member.email,
                  named: member.displayName !== null,
                }}
              />
              <Text style={styles.rosterAction}>Invite</Text>
            </Pressable>
          ))
        ))}
      <TextInput
        value={days}
        onChangeText={(value) => {
          setDays(value.replace(/[^0-9]/g, ''));
        }}
        placeholder="Access expires after (days) — blank means never"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
        keyboardType="number-pad"
      />
      {(invite.isError || revoke.isError) && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(invite.error ?? revoke.error)?.error.message ??
            'Guest access was not changed.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Retention, legal hold and export — rendered only under `capabilities.manage`
 * (see this file's own header on why this section is the one exception that
 * hides rather than shows-and-lets-the-server-refuse, mirroring web exactly).
 *
 * Export has no browser download to fall back on. `Share.share` (React
 * Native core, zero new dependencies) hands the exported JSON to the OS
 * share sheet — Save to Files, AirDrop, email, whatever the device offers —
 * which is the mobile-native equivalent of web's Blob-and-anchor download,
 * not a reduced substitute for it.
 */
function ComplianceSection({
  channelId,
  channel,
}: {
  readonly channelId: ChannelId;
  readonly channel: ChannelDetail;
}) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(
    channel.retentionDays === null ? '' : String(channel.retentionDays),
  );

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: channelQueryKey(channelId) });
  };

  const retention = useMutation({
    mutationFn: () =>
      apiClient.chat.compliance.setRetention.mutate({
        channelId,
        retentionDays: days.trim() === '' ? null : Number.parseInt(days, 10),
      }),
    onSuccess: refresh,
  });

  const hold = useMutation({
    mutationFn: (held: boolean) =>
      apiClient.chat.compliance.holdChannel.mutate({ channelId, held }),
    onSuccess: refresh,
  });

  const exportChannel = useMutation({
    mutationFn: () => apiClient.chat.compliance.export.mutate({ channelId, includeDeleted: true }),
    onSuccess: (result) => {
      void Share.share({
        title: `${result.channelName ?? 'channel'}-export.json`,
        message: JSON.stringify(result, null, 2),
      });
    },
  });

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Retention &amp; compliance</Text>

      <View style={styles.retentionRow}>
        <TextInput
          value={days}
          onChangeText={(value) => {
            setDays(value.replace(/[^0-9]/g, ''));
          }}
          placeholder="Never"
          placeholderTextColor={colors.inkFaint.hex}
          style={[styles.formInput, styles.retentionInput]}
          keyboardType="number-pad"
        />
        <Pressable
          style={styles.retentionSave}
          disabled={retention.isPending}
          onPress={() => {
            retention.mutate();
          }}
        >
          <Text style={styles.formSubmitText}>Save</Text>
        </Pressable>
      </View>
      <Text style={styles.sectionHint}>
        Delete messages older than this many days. Leave blank to keep them indefinitely; deletions
        are recorded in the audit log.
      </Text>

      <View style={styles.rosterRow}>
        <View style={styles.identityRow}>
          <Text style={styles.rosterAction}>Legal hold</Text>
          <Text style={styles.sectionHint}>
            {channel.retentionHold ? 'On — retention will not delete anything here' : 'Off'}
          </Text>
        </View>
        <Pressable
          disabled={hold.isPending}
          onPress={() => {
            hold.mutate(!channel.retentionHold);
          }}
        >
          <Text style={styles.rosterAction}>{channel.retentionHold ? 'Lift' : 'Place'}</Text>
        </Pressable>
      </View>

      <View style={styles.rosterRow}>
        <Text style={styles.rosterAction}>Export conversation</Text>
        <Pressable
          disabled={exportChannel.isPending}
          onPress={() => {
            exportChannel.mutate();
          }}
        >
          <Text style={styles.rosterAction}>Export</Text>
        </Pressable>
      </View>

      {(retention.isError || hold.isError || exportChannel.isError) && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(retention.error ?? hold.error ?? exportChannel.error)?.error.message ??
            'That change could not be saved.'}
        </Text>
      )}
    </View>
  );
}

function BackButton() {
  return (
    <Pressable
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  section: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex + '60',
    paddingTop: 14,
    paddingBottom: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  sectionEmpty: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  identityName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  identityTopic: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  identityTopicEmpty: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  editLink: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  archivedNotice: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.warning.hex,
  },
  personLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  avatarSmall: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceHover.hex,
  },
  avatarSmallText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  personLabel: {
    fontSize: 14,
    color: colors.ink.hex,
    flexShrink: 1,
  },
  personSuffix: {
    color: colors.inkFaint.hex,
  },
  rosterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 4,
  },
  rosterAction: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  formActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  formSubmit: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  formSubmitDisabled: {
    opacity: 0.5,
  },
  formSubmitText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  modalCancel: {
    paddingVertical: 8,
  },
  modalCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  excerptRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    padding: 10,
    backgroundColor: colors.surfaceRaised.hex,
  },
  excerptBody: {
    flex: 1,
    gap: 2,
  },
  excerptText: {
    fontSize: 12,
    color: colors.ink.hex,
  },
  excerptDeleted: {
    fontSize: 12,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  excerptMeta: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  fileName: {
    fontSize: 13,
    color: colors.ink.hex,
    flex: 1,
  },
  fileStatus: {
    fontSize: 12,
    color: colors.warning.hex,
  },
  retentionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  retentionInput: {
    flex: 1,
  },
  retentionSave: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  archiveSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 14,
    gap: 4,
  },
  archiveButton: {
    alignSelf: 'flex-start',
  },
  archiveButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
