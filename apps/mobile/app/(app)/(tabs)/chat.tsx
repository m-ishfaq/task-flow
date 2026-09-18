import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { useMembers, type Member } from '../../../src/lib/use-members.js';
import {
  ALL_PINS_QUERY_KEY,
  CHANNELS_QUERY_KEY,
  SAVED_QUERY_KEY,
  channelDisplayName,
  channelTypeGlyph,
  unreadCountsQueryKey,
  type AllPinnedMessage,
  type Channel,
  type SavedMessage,
} from '../../../src/lib/chat.js';
import { FabMenu } from '../../../src/lib/fab.js';
import { SkeletonList } from '../../../src/lib/skeleton.js';
import { shadows } from '../../../src/lib/premium.js';
import { toast, ToastHost } from '../../../src/lib/toast.js';

const TOPBAR_ICON_CLEARANCE = 120;

/**
 * Chat's entry point — the fourth tab (see `_layout.tsx`). Wave 3's
 * roadmap row — see `chat.ts`'s own header for what's shipped and what is
 * still deferred.
 *
 * Every channel the caller can see, `joined` ones first — mirrors what
 * `chat.channels.list` already computes server-side rather than
 * re-deriving a sort here; a channel this account has not joined still
 * shows (matching `apps/web`'s own sidebar, which lists public channels a
 * member could join), just below the ones it has.
 *
 * **A DM's name is now the participants' real names**, resolved through
 * `useMembers()` — a real device video review found the previous plain
 * "Direct message"/"Direct message (N people)" placeholder unusable
 * ("cant see... for direct message show names of persons involved"). And
 * **there is now a way to create something**: a "+" opens a plain sheet
 * offering "New channel" (hidden unless `channels.list`'s own
 * `canCreateChannel` says so — the server's capability, never a role
 * check) and "New direct message" (needs no such gate — `openDirect`'s own
 * router comment: starting a DM is `channel:read`, the same permission
 * that already got the caller onto this screen).
 *
 * **Unread badges — `chat.channels.unreadCounts`, polled every 15s.**
 * Mirrors `apps/web`'s own `unreadCountsQuery` exactly: no socket needed,
 * because `channel/[channelId].tsx`'s own `markRead` effect (see that
 * file's header) is what actually advances a read cursor — this screen
 * just polls the server's count of what has not caught up to it yet. A
 * badge running a few seconds stale after reading a channel elsewhere is
 * the accepted tradeoff, the same one web's own header names.
 */
export default function Chat() {
  const [composerMode, setComposerMode] = useState<ComposerMode>('closed');
  const [savedOpen, setSavedOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const viewerId = useSession((state) => state.userId);
  const queryClient = useQueryClient();
  const { personOf, isPending: peoplePending } = useMembers();

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: SAVED_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ALL_PINS_QUERY_KEY });
    } finally {
      setRefreshing(false);
    }
  };

  const channels = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.chat.channels.list.query()),
  });
  const paddingTop = useTopInset(4);

  // Org-wide, not per-channel — `chat.saved.list` re-checks `channel:read`
  // on every row and drops what the caller can no longer see, so this
  // count is never stale in the direction that would leak. Enabled
  // unconditionally (unlike `unread` below, which needs a channel list
  // first): a save has no dependency on the channel list ever loading.
  const saved = useQuery({
    queryKey: SAVED_QUERY_KEY,
    queryFn: async () => wire(await apiClient.chat.saved.list.query()),
  });

  // Org-wide pins — same scope reasoning as `saved` above; `allPins`
  // re-checks channel:read per row server-side so the count is never stale
  // in the direction that would leak.
  const allPins = useQuery({
    queryKey: ALL_PINS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.chat.messages.allPins.query()),
  });

  const channelIds = channels.data?.channels.map((channel) => channel.channelId) ?? [];
  const unread = useQuery({
    queryKey: unreadCountsQueryKey(channelIds),
    queryFn: async () => wire(await apiClient.chat.channels.unreadCounts.query({ channelIds })),
    enabled: channelIds.length > 0,
    refetchInterval: 15_000,
  });
  const unreadByChannel = new Map(
    (unread.data ?? []).map((row) => [row.channelId, row.unreadCount]),
  );

  if (channels.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(channels.error)?.error.message ?? "Couldn't load chat."}
        </Text>
      </View>
    );
  }

  const sorted = [...(channels.data?.channels ?? [])].sort(
    (a, b) => Number(b.joined) - Number(a.joined),
  );
  const canCreateChannel = channels.data?.canCreateChannel ?? false;

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Chat</Text>
      </View>

      <FlatList<Channel>
        data={sorted}
        keyExtractor={(channel) => channel.channelId}
        renderItem={({ item }) => (
          <ChannelRow
            channel={item}
            viewerId={viewerId}
            personOf={personOf}
            unreadCount={unreadByChannel.get(item.channelId) ?? 0}
          />
        )}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void doRefresh();
            }}
            tintColor={colors.accent.hex}
          />
        }
        ListEmptyComponent={
          channels.isPending || peoplePending ? (
            <SkeletonList count={6} />
          ) : (
            <Text style={styles.label}>No channels yet.</Text>
          )
        }
      />

      <NewConversationModal
        mode={composerMode}
        canCreateChannel={canCreateChannel}
        onModeChange={setComposerMode}
      />

      <SavedMessagesModal
        open={savedOpen}
        rows={saved.data ?? []}
        onClose={() => {
          setSavedOpen(false);
        }}
      />

      <PinnedMessagesModal
        open={pinnedOpen}
        rows={allPins.data ?? []}
        onClose={() => {
          setPinnedOpen(false);
        }}
      />

      <FabMenu
        label="New conversation, saved or pinned messages"
        bottom={24}
        actions={[
          {
            key: 'new',
            label: 'New conversation',
            icon: 'add-circle-outline',
            onPress: () => {
              setComposerMode('menu');
            },
          },
          {
            key: 'saved',
            label: `Saved${(saved.data?.length ?? 0) > 0 ? ` · ${String(saved.data?.length)}` : ''}`,
            icon: 'bookmark-outline',
            onPress: () => {
              setSavedOpen(true);
            },
          },
          {
            key: 'pinned',
            label: `Pinned${(allPins.data?.length ?? 0) > 0 ? ` · ${String(allPins.data?.length)}` : ''}`,
            icon: 'pin-outline',
            onPress: () => {
              setPinnedOpen(true);
            },
          },
        ]}
      />
      <ToastHost />
    </View>
  );
}

function ChannelRow({
  channel,
  viewerId,
  personOf,
  unreadCount,
}: {
  readonly channel: Channel;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly unreadCount: number;
}) {
  const name = channelDisplayName(channel, viewerId, personOf);
  return (
    <Pressable
      style={styles.row}
     
      onPress={() => {
        router.push(`/channel/${channel.channelId}`);
      }}
    >
      <View style={styles.rowMain}>
        <Text
          style={[styles.rowTitle, !channel.joined && styles.rowTitleUnjoined]}
          numberOfLines={1}
        >
          {channelTypeGlyph(channel.type)}
          {name}
        </Text>
        {unreadCount > 0 && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
          </View>
        )}
      </View>
      {channel.topic !== null && (
        <Text style={styles.rowTopic} numberOfLines={1}>
          {channel.topic}
        </Text>
      )}
    </Pressable>
  );
}

type ComposerMode = 'closed' | 'menu' | 'channel' | 'dm';

/**
 * One `Modal`, three sub-views switched by `mode` — the same bottom-sheet
 * shape `board/[boardId].tsx`'s "Move" modal already established, reused
 * rather than reinvented for a second "pick from a short list" flow.
 */
function NewConversationModal({
  mode,
  canCreateChannel,
  onModeChange,
}: {
  readonly mode: ComposerMode;
  readonly canCreateChannel: boolean;
  readonly onModeChange: (mode: ComposerMode) => void;
}) {
  const close = () => {
    onModeChange('closed');
  };

  return (
    <Modal visible={mode !== 'closed'} transparent animationType="slide" onRequestClose={close}>
      {/* The name/DM-search TextInput below autofocuses the moment either
          form mounts, and this bottom sheet has no keyboard handling of its
          own — found broken on a real device (the box the user is typing
          into was rendered fully behind the open keyboard, the identical
          bug channel/[channelId].tsx's own header already documents for the
          message composer, here on a second screen that never got the same
          fix). `behavior` matches every other composer in this app. */}
      <KeyboardAvoidingView
        style={styles.modalKeyboardAvoider}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.modalBackdrop} onPress={close}>
          {/* Consumes the tap so it never bubbles to the backdrop's own onPress
              above — the same convention board/[boardId].tsx's Move modal uses. */}
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            {mode === 'menu' && (
              <View style={styles.menu}>
                <Text style={styles.modalTitle}>Start something new</Text>
                {canCreateChannel && (
                  <Pressable
                    style={styles.menuRow}
                    onPress={() => {
                      onModeChange('channel');
                    }}
                  >
                    <Text style={styles.menuRowText}>New channel</Text>
                  </Pressable>
                )}
                <Pressable
                  style={styles.menuRow}
                  onPress={() => {
                    onModeChange('dm');
                  }}
                >
                  <Text style={styles.menuRowText}>New direct message</Text>
                </Pressable>
                <Pressable style={styles.modalCancel} onPress={close}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </Pressable>
              </View>
            )}
            {mode === 'channel' && (
              <NewChannelForm
                onDone={close}
                onBack={() => {
                  onModeChange('menu');
                }}
              />
            )}
            {mode === 'dm' && (
              <NewDirectMessageForm
                onDone={close}
                onBack={() => {
                  onModeChange('menu');
                }}
              />
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * The personal bookmark list, ORG-WIDE — ported from `apps/web/src/
 * features/chat/chat-page.tsx`'s own `SavedMessagesButton`/
 * `SavedMessageRow`. `channel-details/[channelId].tsx`'s own "Starred by
 * you" section already reads `chat.saved.list`, but filtered client-side
 * to one channel, matching web's identical per-channel `SavedSection` —
 * this is the OTHER half web has and mobile did not: the unfiltered list,
 * reachable from the channel list itself rather than nested inside one
 * conversation's details, so a message saved in channel A can be found
 * again without first navigating back into channel A. Both screens share
 * the same `SAVED_QUERY_KEY` cache entry (`chat.ts`'s own comment on it) —
 * unsaving from either one updates the other with no second fetch.
 *
 * No `KeyboardAvoidingView` wrapper, unlike `NewConversationModal` above:
 * nothing in this sheet is a text input.
 */
function SavedMessagesModal({
  open,
  rows,
  onClose,
}: {
  readonly open: boolean;
  readonly rows: readonly SavedMessage[];
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const unsave = useMutation({
    mutationFn: (messageId: string) => apiClient.chat.saved.unsave.mutate({ messageId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SAVED_QUERY_KEY });
    },
  });

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Saved messages</Text>
          <ScrollView>
            {rows.length === 0 ? (
              <Text style={styles.label}>Save a message from its menu to find it here later.</Text>
            ) : (
              rows.map((row) => (
                <SavedMessageRow
                  key={row.messageId}
                  row={row}
                  pending={unsave.isPending}
                  onOpen={() => {
                    onClose();
                    router.push(`/channel/${row.channelId}`);
                  }}
                  onUnsave={() => {
                    unsave.mutate(row.messageId);
                  }}
                />
              ))
            )}
          </ScrollView>
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SavedMessageRow({
  row,
  pending,
  onOpen,
  onUnsave,
}: {
  readonly row: SavedMessage;
  readonly pending: boolean;
  readonly onOpen: () => void;
  readonly onUnsave: () => void;
}) {
  return (
    <View style={styles.savedRow}>
      <Pressable style={styles.savedRowMain} onPress={onOpen}>
        <Text style={styles.savedRowChannel} numberOfLines={1}>
          {channelTypeGlyph(row.channelType)}
          {row.channelName ?? 'Direct message'}
        </Text>
        <Text style={styles.savedRowExcerpt} numberOfLines={2}>
          {row.excerpt ?? '(message deleted)'}
        </Text>
        <Text style={styles.savedRowTime}>
          Saved {formatDistanceToNow(new Date(row.savedAt), { addSuffix: true })}
        </Text>
      </Pressable>
      <Pressable disabled={pending} onPress={onUnsave} hitSlop={8}>
        <Text style={styles.savedRowUnsave}>Unsave</Text>
      </Pressable>
    </View>
  );
}

/**
 * All messages pinned across every channel the caller can see — the org-wide
 * counterpart to `SavedMessagesModal`. Mirrors `apps/web/src/features/chat/
 * chat-page.tsx`'s own pinned-messages panel: tapping a row navigates into
 * the channel the pin lives in. No "unpin" action here — the per-channel
 * details screen owns that, where the full channel context (moderator check,
 * channel name) is already loaded.
 */
function PinnedMessagesModal({
  open,
  rows,
  onClose,
}: {
  readonly open: boolean;
  readonly rows: readonly AllPinnedMessage[];
  readonly onClose: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Pinned messages</Text>
          <ScrollView>
            {rows.length === 0 ? (
              <Text style={styles.label}>No pinned messages yet.</Text>
            ) : (
              rows.map((row) => (
                <PinnedMessageRow
                  key={row.messageId}
                  row={row}
                  onOpen={() => {
                    onClose();
                    router.push(`/channel/${row.channelId}`);
                  }}
                />
              ))
            )}
          </ScrollView>
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PinnedMessageRow({
  row,
  onOpen,
}: {
  readonly row: AllPinnedMessage;
  readonly onOpen: () => void;
}) {
  return (
    <Pressable style={styles.savedRow} onPress={onOpen}>
      <Text style={styles.savedRowChannel} numberOfLines={1}>
        {channelTypeGlyph(row.channelType)}
        {row.channelName ?? 'Direct message'}
      </Text>
      <Text style={styles.savedRowExcerpt} numberOfLines={2}>
        {row.excerpt ?? '(message deleted)'}
      </Text>
      <Text style={styles.savedRowTime}>
        Pinned {formatDistanceToNow(new Date(row.pinnedAt), { addSuffix: true })}
        {row.pinnedBy !== null ? ` by ${row.pinnedBy}` : ''}
      </Text>
    </Pressable>
  );
}

function NewChannelForm({
  onDone,
  onBack,
}: {
  readonly onDone: () => void;
  readonly onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'public' | 'private'>('public');

  const create = useMutation({
    mutationFn: () =>
      apiClient.chat.channels.create.mutate({ type, name: name.trim(), topic: null }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      toast.success('Channel created');
      onDone();
      router.push(`/channel/${result.channelId}`);
    },
  });

  return (
    <View style={styles.form}>
      <Text style={styles.modalTitle}>New channel</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Channel name"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
        autoFocus
      />
      <View style={styles.typeRow}>
        <Pressable
          style={[styles.typeChip, type === 'public' && styles.typeChipActive]}
          onPress={() => {
            setType('public');
          }}
        >
          <Text style={[styles.typeChipText, type === 'public' && styles.typeChipTextActive]}>
            Public
          </Text>
        </Pressable>
        <Pressable
          style={[styles.typeChip, type === 'private' && styles.typeChipActive]}
          onPress={() => {
            setType('private');
          }}
        >
          <Text style={[styles.typeChipText, type === 'private' && styles.typeChipTextActive]}>
            Private
          </Text>
        </Pressable>
      </View>
      {create.isError && (
        <Text style={styles.formError} accessibilityRole="alert">
          {apiErrorOf(create.error)?.error.message ?? 'The channel could not be created.'}
        </Text>
      )}
      <View style={styles.formActions}>
        <Pressable
          style={[
            styles.formSubmit,
            (create.isPending || name.trim() === '') && styles.formSubmitDisabled,
          ]}
          disabled={create.isPending || name.trim() === ''}
          onPress={() => {
            create.mutate();
          }}
        >
          {create.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.formSubmitText}>Create</Text>
          )}
        </Pressable>
        <Pressable style={styles.modalCancel} onPress={onBack}>
          <Text style={styles.modalCancelText}>Back</Text>
        </Pressable>
      </View>
    </View>
  );
}

function NewDirectMessageForm({
  onDone,
  onBack,
}: {
  readonly onDone: () => void;
  readonly onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const viewerId = useSession((state) => state.userId);
  const { people } = useMembers();
  const [selected, setSelected] = useState<readonly string[]>([]);

  const candidates = people.filter((member) => member.userId !== viewerId);

  const open = useMutation({
    mutationFn: () => apiClient.chat.channels.openDirect.mutate({ userIds: selected }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      toast.success('Conversation opened');
      onDone();
      router.push(`/channel/${result.channelId}`);
    },
  });

  return (
    <View style={styles.form}>
      <Text style={styles.modalTitle}>New direct message</Text>
      <ScrollView style={styles.candidateList}>
        {candidates.map((member) => {
          const isSelected = selected.includes(member.userId);
          return (
            <Pressable
              key={member.userId}
              style={styles.candidateRow}
              onPress={() => {
                setSelected((current) =>
                  isSelected
                    ? current.filter((id) => id !== member.userId)
                    : [...current, member.userId],
                );
              }}
            >
              <Text style={styles.candidateLabel}>{labelOf(member)}</Text>
              {isSelected && <Text style={styles.candidateCheck}>✓</Text>}
            </Pressable>
          );
        })}
        {candidates.length === 0 && <Text style={styles.label}>No one else to message yet.</Text>}
      </ScrollView>
      {open.isError && (
        <Text style={styles.formError} accessibilityRole="alert">
          {apiErrorOf(open.error)?.error.message ?? 'That conversation could not be opened.'}
        </Text>
      )}
      <View style={styles.formActions}>
        <Pressable
          style={[
            styles.formSubmit,
            (open.isPending || selected.length === 0) && styles.formSubmitDisabled,
          ]}
          disabled={open.isPending || selected.length === 0}
          onPress={() => {
            open.mutate();
          }}
        >
          {open.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.formSubmitText}>Start</Text>
          )}
        </Pressable>
        <Pressable style={styles.modalCancel} onPress={onBack}>
          <Text style={styles.modalCancelText}>Back</Text>
        </Pressable>
      </View>
    </View>
  );
}

function labelOf(member: Member): string {
  return member.displayName ?? member.email;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    gap: 12,
    backgroundColor: colors.surface.hex,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  titleRow: {
    height: 36,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingRight: TOPBAR_ICON_CLEARANCE,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 10,
    paddingBottom: 16,
  },
  row: {
    ...shadows.sm,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    gap: 4,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.ink.hex,
  },
  rowTitleUnjoined: {
    color: colors.inkMuted.hex,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.hex,
  },
  unreadBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accentInk.hex,
  },
  rowTopic: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  modalKeyboardAvoider: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay.hex + '99',
    justifyContent: 'flex-end',
  },
  modalCard: {
    ...shadows.sm,
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    maxHeight: '75%',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 12,
  },
  menu: {
    gap: 4,
  },
  menuRow: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  menuRowText: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  savedRow: {
    gap: 4,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  savedRowMain: {
    gap: 2,
  },
  savedRowChannel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  savedRowExcerpt: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  savedRowTime: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  savedRowUnsave: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  form: {
    gap: 10,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  typeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  typeChip: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  typeChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  typeChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  typeChipTextActive: {
    color: colors.accentInk.hex,
  },
  candidateList: {
    maxHeight: 320,
  },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  candidateLabel: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  candidateCheck: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.accent.hex,
  },
  formError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  formActions: {
    gap: 4,
  },
  formSubmit: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
  },
  formSubmitDisabled: {
    opacity: 0.5,
  },
  formSubmitText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
});
