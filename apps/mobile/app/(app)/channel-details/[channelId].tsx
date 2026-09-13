import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
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
import { Avatar } from '../../../src/lib/avatar.js';
import { TelephonyCallButton } from '../../../src/lib/telephony-call-button.js';
import { directoryMemberQueryKey } from '../../../src/lib/people.js';
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
 * A channel's Details screen — polished Telegram-style design with a hero
 * header (large avatar, channel name, member count), pull-to-refresh, and
 * cleaner section cards. Preserves all original functionality: roster,
 * add/remove, rename/topic, pinned, saved, files, call history, guest
 * access, compliance, and archive/restore.
 */
export default function ChannelDetailsScreen() {
  const params = useLocalSearchParams<{ channelId: string }>();
  const parsedChannelId = ChannelIdSchema.safeParse(params.channelId);

  if (!parsedChannelId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This channel link isn't valid.</Text>
        <Pressable
          style={styles.navBack}
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.navBackText}>‹ Back</Text>
        </Pressable>
      </View>
    );
  }

  return <ChannelDetailsContent channelId={parsedChannelId.data} />;
}

function ChannelDetailsContent({ channelId }: { channelId: ChannelId }) {
  const queryClient = useQueryClient();
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const paddingTop = useTopInset(0);
  const [refreshing, setRefreshing] = useState(false);

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

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
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
      <View style={[styles.center, { paddingTop }]}>
        <Text style={styles.label}>
          {apiErrorOf(channel.error)?.error.message ?? "Couldn't load this channel."}
        </Text>
        <Pressable
          style={styles.navBack}
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.navBackText}>‹ Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop }]}>
      {/* Fixed nav bar */}
      <View style={styles.navBar}>
        <Pressable
          style={styles.navBack}
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.navBackText}>‹</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          {data !== undefined ? (isDirect ? 'Chat Info' : 'Channel Info') : 'Info'}
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void doRefresh();
            }}
            tintColor={colors.accent.hex}
          />
        }
      >
        {data === undefined ? (
          <ActivityIndicator color={colors.accent.hex} style={styles.loadingCenter} />
        ) : (
          <>
            <ChannelHero
              channel={data}
              isDirect={isDirect}
              viewerId={viewerId}
              personOf={personOf}
            />

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
              <AddMemberControl
                channelId={channelId}
                memberIds={data.memberIds}
                onAdded={refresh}
              />
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
              <View style={styles.dangerSection}>
                <Pressable
                  style={styles.dangerButton}
                  disabled={archive.isPending}
                  onPress={() => {
                    archive.mutate();
                  }}
                >
                  <Text style={styles.dangerButtonText}>
                    {data.archivedAt === null ? 'Archive channel' : 'Restore channel'}
                  </Text>
                </Pressable>
                {archive.isError && (
                  <Text style={styles.sectionError} accessibilityRole="alert">
                    {apiErrorOf(archive.error)?.error.message ??
                      'The channel could not be archived.'}
                  </Text>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** Telegram-style hero header — large avatar, channel name, member count. */
function ChannelHero({
  channel,
  isDirect,
  viewerId,
  personOf,
}: {
  readonly channel: ChannelDetail;
  readonly isDirect: boolean;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
}) {
  const others = channel.memberIds.filter((id) => id !== viewerId);

  let heroLabel: string;
  let heroInitial: string;
  let heroMeta: string;

  if (isDirect) {
    if (others.length === 1 && others[0] !== undefined) {
      const person = personOf(others[0]);
      heroLabel = person.label;
      heroInitial = person.label.slice(0, 1).toUpperCase();
    } else {
      heroLabel = 'Group conversation';
      heroInitial = 'G';
    }
    heroMeta = `${String(channel.memberIds.length)} ${channel.memberIds.length === 1 ? 'member' : 'members'}`;
  } else {
    heroLabel = channel.name ?? 'Channel';
    heroInitial = (channel.name ?? '#').slice(0, 1).toUpperCase();
    const typeStr = channel.type === 'public' ? '# Public' : '🔒 Private';
    heroMeta = `${typeStr} · ${String(channel.memberIds.length)} ${channel.memberIds.length === 1 ? 'member' : 'members'}`;
  }

  return (
    <View style={styles.hero}>
      <View style={styles.heroAvatar}>
        <Text style={styles.heroAvatarText}>{heroInitial}</Text>
      </View>
      <Text style={styles.heroName}>{heroLabel}</Text>
      <Text style={styles.heroMeta}>{heroMeta}</Text>
      {channel.archivedAt !== null && (
        <View style={styles.heroBadge}>
          <Text style={styles.heroBadgeText}>Archived</Text>
        </View>
      )}
    </View>
  );
}

/** Who you are talking to, for a DM — phone call action if available. */
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
  const only = others.length === 1 ? others[0] : undefined;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>
        {others.length === 1 ? 'Direct message with' : 'Group conversation'}
      </Text>
      {others.map((userId) => (
        <PersonLine key={userId} person={personOf(userId)} />
      ))}
      {only !== undefined && <DirectCallAction userId={only} />}
    </View>
  );
}

/**
 * Click-to-call the other side of a 1:1 DM. Only for a two-person DM —
 * a group conversation has no single callee. Phone number comes from the
 * directory, not useMembers (which is intentionally narrow). Silent when
 * there is no number.
 */
function DirectCallAction({ userId }: { readonly userId: string }) {
  const member = useQuery({
    queryKey: directoryMemberQueryKey(userId),
    queryFn: async () => wire(await apiClient.people.directory.get.query({ userId })),
  });
  const workPhone = member.data?.workPhone ?? null;

  if (workPhone === null) return null;

  return (
    <View style={styles.directCallRow}>
      <Text style={styles.directCallPhone}>{workPhone}</Text>
      <TelephonyCallButton to={workPhone} />
    </View>
  );
}

/** Channel name/topic with inline rename form gated on `capabilities.manage`. */
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
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Edit channel</Text>
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
            style={styles.cancelLink}
            onPress={() => {
              setEditing(false);
            }}
          >
            <Text style={styles.cancelLinkText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      {channel.topic !== null ? (
        <>
          <Text style={styles.sectionTitle}>Topic</Text>
          <Text style={styles.topicText}>{channel.topic}</Text>
        </>
      ) : (
        <Text style={styles.topicEmpty}>No topic set.</Text>
      )}
      {channel.capabilities.manage && (
        <Pressable
          style={styles.editTopicLink}
          onPress={() => {
            setEditing(true);
          }}
        >
          <Text style={styles.editTopicLinkText}>
            {channel.topic !== null ? 'Edit topic' : 'Set topic & name'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** A person row with a large initial avatar and optional suffix text. */
function PersonLine({
  person,
  suffix,
}: {
  readonly person: Person;
  readonly suffix?: string | undefined;
}) {
  return (
    <View style={styles.personLine}>
      <Avatar seed={person.userId} label={person.label} size={36} />
      <Text style={styles.personLabel} numberOfLines={1}>
        {person.label}
        {suffix !== undefined && <Text style={styles.personSuffix}>{suffix}</Text>}
      </Text>
    </View>
  );
}

/** Above this many members, a search box earns its place — the same
 *  threshold `org-settings.tsx`'s own roster search uses, and the same
 *  Design Bible §20 worked example ("128 members scroll past forever")
 *  this channel's own roster had never gotten the fix for. Below it, a
 *  search box is one more control to read for a list a thumb already
 *  scrolls past in a beat. */
const ROSTER_SEARCH_THRESHOLD = 8;

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
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ''
      ? memberIds
      : memberIds.filter((userId) => personOf(userId).label.toLowerCase().includes(needle));

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Members · {memberIds.length}</Text>
      {memberIds.length > ROSTER_SEARCH_THRESHOLD && (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search members…"
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.formInput}
          autoCapitalize="none"
        />
      )}
      {memberIds.length === 0 ? (
        <Text style={styles.sectionEmpty}>This channel has no members.</Text>
      ) : visible.length === 0 ? (
        <Text style={styles.sectionEmpty}>No match.</Text>
      ) : (
        visible.map((userId) => {
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

/** Search by email, mirroring `apps/web`'s own `AddMemberControl` exactly. */
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
    <View style={styles.card}>
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

/** Every call this conversation has had, newest first. */
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
    <View style={styles.card}>
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
    <View style={styles.card}>
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
    <View style={styles.card}>
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
    <View style={styles.card}>
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
    <View style={styles.card}>
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
 * Retention, legal hold and export — rendered only under `capabilities.manage`.
 * Export uses `Share.share` (React Native core) to hand JSON to the OS share
 * sheet — Save to Files, AirDrop, email — the mobile equivalent of a Blob
 * download.
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
    <View style={styles.card}>
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
        Delete messages older than this many days. Leave blank to keep them indefinitely.
      </Text>

      <View style={styles.rosterRow}>
        <View style={styles.legalHoldLabel}>
          <Text style={styles.fieldBold}>Legal hold</Text>
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
        <Text style={styles.fieldBold}>Export conversation</Text>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: 48,
    gap: 12,
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
  loadingCenter: {
    marginTop: 48,
  },

  /* Nav bar */
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex + '60',
    backgroundColor: colors.surface.hex,
  },
  navBack: {
    paddingVertical: 4,
    paddingRight: 10,
  },
  navBackText: {
    fontSize: 22,
    fontWeight: '400',
    color: colors.accent.hex,
    lineHeight: 26,
  },
  navTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: colors.ink.hex,
  },

  /* Hero */
  hero: {
    alignItems: 'center',
    paddingTop: 28,
    paddingBottom: 20,
    paddingHorizontal: 24,
    gap: 8,
    backgroundColor: colors.surface.hex,
  },
  heroAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.accent.hex + '22',
    borderWidth: 3,
    borderColor: colors.accent.hex + '44',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  heroAvatarText: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.accent.hex,
  },
  heroName: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink.hex,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  heroMeta: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  heroBadge: {
    backgroundColor: colors.warning.hex + '22',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginTop: 4,
  },
  heroBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.warning.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  /* Cards / sections */
  card: {
    backgroundColor: colors.surfaceRaised.hex,
    marginHorizontal: 16,
    borderRadius: radiusCard + 2,
    padding: 16,
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line.hex + '60',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    lineHeight: 16,
  },
  sectionEmpty: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  fieldBold: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },

  /* Person rows */
  personLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  personLabel: {
    fontSize: 14,
    color: colors.ink.hex,
    flexShrink: 1,
  },
  personSuffix: {
    color: colors.inkFaint.hex,
    fontWeight: '400',
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

  /* Channel identity */
  topicText: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    lineHeight: 20,
  },
  topicEmpty: {
    fontSize: 14,
    color: colors.inkFaint.hex,
    fontStyle: 'italic',
  },
  editTopicLink: {
    alignSelf: 'flex-start',
  },
  editTopicLinkText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },

  /* Direct call row */
  directCallRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex + '60',
  },
  directCallPhone: {
    flex: 1,
    fontSize: 13,
    color: colors.inkMuted.hex,
    fontVariant: ['tabular-nums'],
  },

  /* Forms */
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
    paddingHorizontal: 18,
    paddingVertical: 9,
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
  cancelLink: {
    paddingVertical: 8,
  },
  cancelLinkText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },

  /* Excerpt rows */
  excerptRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    padding: 10,
    backgroundColor: colors.surfaceSunken.hex,
  },
  excerptBody: {
    flex: 1,
    gap: 3,
  },
  excerptText: {
    fontSize: 13,
    color: colors.ink.hex,
    lineHeight: 18,
  },
  excerptDeleted: {
    fontSize: 13,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  excerptMeta: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },

  /* Files */
  fileName: {
    fontSize: 13,
    color: colors.ink.hex,
    flex: 1,
  },
  fileStatus: {
    fontSize: 12,
    color: colors.warning.hex,
    fontWeight: '600',
  },

  /* Retention */
  retentionRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  retentionInput: {
    flex: 1,
  },
  retentionSave: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legalHoldLabel: {
    flex: 1,
    gap: 2,
  },

  /* Danger zone */
  dangerSection: {
    marginHorizontal: 16,
    marginTop: 4,
    gap: 6,
    paddingBottom: 8,
  },
  dangerButton: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  dangerButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
