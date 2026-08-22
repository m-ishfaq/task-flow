import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import type { ChannelId } from '@taskflow/contracts';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { useSession } from './use-session.js';
import { activeCallQueryKey, invalidateCalls } from './rtc.js';
import { joinCall, useCallStore } from './use-call.js';

/**
 * "Call" / "Join call" — the channel header's own button, ported from
 * `apps/web/src/features/rtc/call-button.tsx`.
 *
 * ## It re-derives no authorization
 *
 * The button renders for everyone and the server answers — the same
 * argument CLAUDE.md's §8.2 makes everywhere else in this app. A `viewer`
 * who cannot start a call gets an honest refusal via the mutation's own
 * error, surfaced inline, rather than a control that silently is not
 * there — matching this screen's own established pattern for every other
 * permission-gated action (react `error` state, not a re-derived check).
 *
 * ## Why one button and two verbs
 *
 * A live call in this conversation makes the action JOIN, not START — and
 * the server would refuse a second one anyway
 * (`sessions_one_live_per_channel`). The caption follows the server's own
 * answer rather than a local guess, so the two cannot disagree about
 * whether a call is happening.
 */
export function CallButton({
  orgId,
  channelId,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const selfId = useSession((state) => state.userId);
  const active = useQuery({
    queryKey: activeCallQueryKey(orgId, channelId),
    queryFn: async () => wire(await apiClient.rtc.active.query({ channelId })),
    enabled: orgId !== '',
    refetchInterval: 6_000,
  });
  const currentSessionId = useCallStore((state) => state.sessionId);

  const live = active.data;
  const alreadyIn = currentSessionId !== null && live?.sessionId === currentSessionId;

  const start = useMutation({
    mutationFn: async () => {
      if (selfId === null) throw new Error('Not signed in.');

      const sessionId =
        live?.sessionId ??
        (await apiClient.rtc.start.mutate({ channelId, kind: 'audio' })).sessionId;

      await joinCall({ orgId, sessionId, channelId, selfId });
    },
    onSuccess: async () => {
      await invalidateCalls(queryClient, orgId, channelId);
    },
  });

  if (alreadyIn) {
    return <Text style={styles.inCallText}>In call</Text>;
  }

  return (
    <Pressable
      style={[styles.button, live == null ? styles.buttonGhost : styles.buttonPrimary]}
      disabled={start.isPending || selfId === null}
      onPress={() => {
        start.mutate();
      }}
    >
      {start.isPending ? (
        <ActivityIndicator color={live == null ? colors.accent.hex : colors.accentInk.hex} />
      ) : (
        <Text style={live == null ? styles.buttonGhostText : styles.buttonPrimaryText}>
          {live == null ? '📞 Call' : '📞 Join call'}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  buttonGhost: {
    borderWidth: 1,
    borderColor: colors.line.hex,
  },
  buttonGhostText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  buttonPrimary: {
    backgroundColor: colors.accent.hex,
  },
  buttonPrimaryText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accentInk.hex,
  },
  inCallText: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
});
