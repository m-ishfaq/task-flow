import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { useMembers, type Member } from '../../../src/lib/use-members.js';
import { CHANNELS_QUERY_KEY, channelDisplayName, type Channel } from '../../../src/lib/chat.js';

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
 */
export default function Chat() {
  const [composerMode, setComposerMode] = useState<ComposerMode>('closed');
  const viewerId = useSession((state) => state.userId);
  const { personOf, isPending: peoplePending } = useMembers();

  const channels = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.chat.channels.list.query()),
  });
  const paddingTop = useTopInset();

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
        <Pressable
          style={styles.newButton}
          onPress={() => {
            setComposerMode('menu');
          }}
        >
          <Text style={styles.newButtonText}>+ New</Text>
        </Pressable>
      </View>

      <FlatList<Channel>
        data={sorted}
        keyExtractor={(channel) => channel.channelId}
        renderItem={({ item }) => (
          <ChannelRow channel={item} viewerId={viewerId} personOf={personOf} />
        )}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          channels.isPending || peoplePending ? (
            <ActivityIndicator color={colors.accent.hex} />
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
    </View>
  );
}

function ChannelRow({
  channel,
  viewerId,
  personOf,
}: {
  readonly channel: Channel;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
}) {
  const name = channelDisplayName(channel, viewerId, personOf);
  return (
    <Pressable
      style={styles.row}
      onPress={() => {
        router.push(`/channel/${channel.channelId}`);
      }}
    >
      <Text style={[styles.rowTitle, !channel.joined && styles.rowTitleUnjoined]}>
        {channel.type === 'public' || channel.type === 'private' ? `# ${name}` : name}
      </Text>
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
    <Modal visible={mode !== 'closed'} transparent animationType="fade" onRequestClose={close}>
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  newButton: {
    borderWidth: 1,
    borderColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  newButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 8,
    paddingBottom: 8,
  },
  row: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  rowTitleUnjoined: {
    color: colors.inkMuted.hex,
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
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard,
    borderTopRightRadius: radiusCard,
    padding: 20,
    maxHeight: '75%',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 8,
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
  form: {
    gap: 10,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex,
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
    borderColor: colors.line.hex,
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
