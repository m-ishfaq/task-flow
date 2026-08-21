import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { CHANNELS_QUERY_KEY, channelDisplayName, type Channel } from '../../../src/lib/chat.js';

/**
 * Chat's entry point — the fourth tab (see `_layout.tsx`). Wave 3's
 * roadmap row, read + send only — see `chat.ts`'s own header for the full
 * scope line.
 *
 * Every channel the caller can see, `joined` ones first — mirrors what
 * `chat.channels.list` already computes server-side rather than
 * re-deriving a sort here; a channel this account has not joined still
 * shows (matching `apps/web`'s own sidebar, which lists public channels a
 * member could join), just below the ones it has.
 */
export default function Chat() {
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

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Text style={styles.title}>Chat</Text>

      <FlatList<Channel>
        data={sorted}
        keyExtractor={(channel) => channel.channelId}
        renderItem={({ item }) => <ChannelRow channel={item} />}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          channels.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.label}>No channels yet.</Text>
          )
        }
      />
    </View>
  );
}

function ChannelRow({ channel }: { readonly channel: Channel }) {
  return (
    <Pressable
      style={styles.row}
      onPress={() => {
        router.push(`/channel/${channel.channelId}`);
      }}
    >
      <Text style={[styles.rowTitle, !channel.joined && styles.rowTitleUnjoined]}>
        {channel.type === 'public' || channel.type === 'private'
          ? `# ${channelDisplayName(channel)}`
          : channelDisplayName(channel)}
      </Text>
      {channel.topic !== null && (
        <Text style={styles.rowTopic} numberOfLines={1}>
          {channel.topic}
        </Text>
      )}
    </Pressable>
  );
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
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
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
});
