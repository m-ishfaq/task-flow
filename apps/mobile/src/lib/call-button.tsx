import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import type { ChannelId } from '@taskflow/contracts';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { useSession } from './use-session.js';
import { errorMessageOf } from './trpc-client.js';
import { useIsOffline } from './use-network-status.js';
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
 * who cannot start a call gets an honest refusal from the mutation's own
 * error — matching this app's own established pattern for every other
 * permission-gated action (react `error` state, not a re-derived check).
 *
 * ## The error IS surfaced, via `Alert` — this file's own claim was false
 * until a real public-channel call proved it
 *
 * The comment above used to say "surfaced inline", which described web's
 * behavior (a toast, ported alongside everything else in this file) rather
 * than what this file's own JSX actually did — nothing: `start.error` was
 * never read anywhere, so `session.service.ts`'s own honest, already-written
 * refusal ("Calls in public channels are not available yet — start one from
 * a direct message or a private channel.") reached exactly nobody. A member
 * tapping Call in a public channel saw the button stop loading and nothing
 * else, which reads as "broken" rather than "not supported yet". This app
 * has no toast system, unlike web, so `Alert.alert` — zero new
 * infrastructure, and the same one-shot, dismiss-and-move-on shape a toast
 * has — is what actually closes the gap, for every reason a start can fail,
 * not only the public-channel one.
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
  const isOffline = useIsOffline();
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
    onError: (error) => {
      Alert.alert('Call not started', errorMessageOf(error, isOffline));
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
    borderColor: colors.line.hex + '80',
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
