import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, gatewaySocket } from './app-session.js';
import { useSession } from './use-session.js';
import { useMembers } from './use-members.js';
import { startRingback, startRingtone, type Ringing } from './ringtone-player.js';
import {
  CALL_PREFS_QUERY_KEY,
  elapsedSeconds,
  formatCallDuration,
  incomingCallsQueryKey,
  invalidateCalls,
  recordingQueryKey,
  type IncomingCall,
  type RecordingStatus,
} from './rtc.js';
import {
  callStore,
  clearEviction,
  hangUp,
  joinCall,
  setMuted,
  setSpeakerphone,
  useCallStore,
} from './use-call.js';

/**
 * Everything about a call that must outlive the screen it started on
 * (ai/phase-13-webrtc.md §7), mounted once in `(app)/_layout.tsx` — the
 * mobile counterpart of `apps/web/src/features/rtc/call-surface.tsx`. A
 * ringing call has to be answerable from wherever somebody happens to be,
 * and a call in progress has to survive navigating away from the
 * conversation — a microphone that stops when a route unmounts is not a
 * phone, the same reason `use-call.ts` keeps the call in module state
 * rather than in a component.
 *
 * ## The ring arrives on a socket and is CONFIRMED by a poll
 *
 * `gatewaySocket.onIncomingCall` (already wired in `socket.ts`, unused
 * until this file) is what makes the phone ring within milliseconds on
 * whatever screen is open. Polling `rtc.incoming` is what makes it ring at
 * all if that message was missed — a socket asleep in the background, a
 * reconnect mid-ring, a gateway restart. Phase 4's own NOTIFY/poll
 * relationship, restated here: delete the socket handler and calls still
 * ring, six seconds later; delete the poll and a dropped message is a call
 * that never rang.
 *
 * ## No missed-call toast — this app already has a notification center
 *
 * Web shows a one-off "Missed call from X" toast, reconstructed from the
 * `call:ended` socket message. This app has no global toast system, and
 * does not need to invent one here: `call.missed` is a real, persisted
 * server notification (ai/phase-13-webrtc.md §7) that already reaches this
 * app through the in-app notification center and push, built in an
 * earlier increment. Duplicating that as a transient banner would be a
 * second, less durable copy of a fact the notification center already
 * shows.
 *
 * ## No `<RemoteAudio>` component — and that is not a gap
 *
 * Web attaches each peer's `MediaStream` to a hidden `<audio autoPlay>`
 * element, because a browser tab has no other way to route a stream to
 * speakers. `react-native-webrtc` has no such step for AUDIO: once a track
 * is added to an `RTCPeerConnection` and the connection is live, the
 * native module plays it through the device's own audio session
 * automatically — the explicit-attachment step exists in
 * `RTCView` only for VIDEO, which this phase does not add (Wave 3). So
 * `useCallStore`'s `peers` list exists here purely to drive the UI (who is
 * in the call, and to feed the ringback/duration logic below) — nothing
 * needs to read `peer.stream` for playback itself.
 *
 * ## No RECORD button — see `use-call.ts`'s own header
 *
 * The recording section below shows STATUS (a live indicator) and lets a
 * participant AGREE or REFUSE a request already in progress — both
 * genuinely portable. There is no control here to START a request: a
 * mobile-initiated recording could never actually begin capturing, since
 * this platform has no `MediaRecorder`-over-`MediaStream` equivalent, and
 * showing a button whose only outcome is a checklist that never resolves
 * would be worse than not offering it.
 */
export function CallSurface(): React.JSX.Element {
  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <IncomingCallBanner />
      <ActiveCallBar />
    </View>
  );
}

/** Forces a re-render once a second while `active` — mirrors web's identical hook. */
function useTicker(active: boolean): void {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const interval = setInterval(() => {
      forceRender((value) => value + 1);
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [active]);
}

/* -------------------------------------------------------------------------- *
 * Ringing
 * -------------------------------------------------------------------------- */

function IncomingCallBanner(): React.JSX.Element | null {
  const orgId = useSession((state) => state.orgId);
  const selfId = useSession((state) => state.userId);
  const queryClient = useQueryClient();
  const { personOf } = useMembers();
  const currentSessionId = useCallStore((state) => state.sessionId);

  const incoming = useQuery({
    queryKey: incomingCallsQueryKey(orgId ?? ''),
    queryFn: async () => wire(await apiClient.rtc.incoming.query({})),
    enabled: orgId !== null,
    refetchInterval: 6_000,
  });
  const prefs = useQuery({
    queryKey: CALL_PREFS_QUERY_KEY,
    queryFn: () => apiClient.rtc.prefs.get.query({}),
    enabled: orgId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  /* The oldest ring wins — see web's identical comment on why stacking two
     banners is a decision nobody needs to make. */
  const call: IncomingCall | undefined = (incoming.data ?? []).find(
    (row) => row.sessionId !== currentSessionId,
  );

  useEffect(() => {
    if (orgId === null) return undefined;
    const offRinging = gatewaySocket.onIncomingCall(() => {
      void queryClient.invalidateQueries({ queryKey: incomingCallsQueryKey(orgId) });
    });
    const offEnded = gatewaySocket.onCallEnded(() => {
      void queryClient.invalidateQueries({ queryKey: incomingCallsQueryKey(orgId) });
    });
    return () => {
      offRinging();
      offEnded();
    };
  }, [orgId, queryClient]);

  /* How long this has been ringing — ticks once a second while shown.
     `call.createdAt` is the session's own creation instant, not "when this
     screen first noticed" — opening the app mid-ring shows the call's real
     age, not zero. */
  useTicker(call !== undefined);
  const ringingSeconds =
    call === undefined ? 0 : elapsedSeconds(new Date(call.createdAt).getTime());

  const ringtone = prefs.data?.ringtone ?? 'classic';
  const ringEnabled = prefs.data?.ringEnabled ?? true;
  const ringingSessionId = call?.sessionId ?? null;

  useEffect(() => {
    if (ringingSessionId === null || !ringEnabled) return undefined;
    /* `startRingtone` is async — see `ringtone-player.ts`'s own header on
       why. `cancelled` guards the race where this effect's cleanup runs
       (the call was answered/declined, or the banner unmounted) before the
       native module finishes resolving: the tone must never start playing
       after the reason to ring is already gone. */
    let cancelled = false;
    let ringing: Ringing | null = null;
    void startRingtone(ringtone).then((result) => {
      if (cancelled) {
        result.stop();
        return;
      }
      ringing = result;
    });
    return () => {
      cancelled = true;
      ringing?.stop();
    };
  }, [ringingSessionId, ringEnabled, ringtone]);

  const answer = useMutation({
    mutationFn: async () => {
      if (call === undefined || selfId === null || orgId === null) return;
      await joinCall({ orgId, sessionId: call.sessionId, channelId: call.channelId, selfId });
    },
    onSuccess: async () => {
      if (orgId !== null) await invalidateCalls(queryClient, orgId, call?.channelId);
    },
  });

  const decline = useMutation({
    mutationFn: async () => {
      if (call === undefined) return;
      await apiClient.rtc.decline.mutate({ sessionId: call.sessionId });
    },
    onSuccess: async () => {
      if (orgId !== null) await invalidateCalls(queryClient, orgId, call?.channelId);
    },
  });

  if (call === undefined) return null;

  const caller = personOf(call.initiatedBy);
  const initials = caller.label.slice(0, 2).toUpperCase();

  return (
    <View style={styles.bannerCard} pointerEvents="auto">
      <View style={styles.bannerRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={styles.bannerInfo}>
          <Text style={styles.bannerName} numberOfLines={1}>
            {caller.label}
          </Text>
          <Text style={styles.bannerSubtitle}>
            Incoming {call.kind === 'video' ? 'video' : 'voice'} call ·{' '}
            {formatCallDuration(ringingSeconds)}
            {ringEnabled ? '' : ' · silent'}
          </Text>
        </View>
      </View>
      <View style={styles.bannerActions}>
        <Pressable
          style={styles.answerButton}
          disabled={answer.isPending}
          onPress={() => {
            answer.mutate();
          }}
        >
          {answer.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.answerButtonText}>📞 Pick up</Text>
          )}
        </Pressable>
        <Pressable
          style={styles.declineButton}
          disabled={decline.isPending}
          onPress={() => {
            decline.mutate();
          }}
        >
          <Text style={styles.declineButtonText}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * In a call
 * -------------------------------------------------------------------------- */

function ActiveCallBar(): React.JSX.Element | null {
  const orgId = useSession((state) => state.orgId);
  const queryClient = useQueryClient();
  const { personOf } = useMembers();

  const status = useCallStore((state) => state.status);
  const muted = useCallStore((state) => state.muted);
  const speakerOn = useCallStore((state) => state.speakerOn);
  const peers = useCallStore((state) => state.peers);
  const sessionId = useCallStore((state) => state.sessionId);
  const channelId = useCallStore((state) => state.channelId);
  const evicted = useCallStore((state) => state.evicted);
  const connectedAt = useCallStore((state) => state.connectedAt);

  useTicker(connectedAt !== null);
  const durationSeconds = connectedAt === null ? 0 : elapsedSeconds(connectedAt);

  const recording = useQuery({
    queryKey: recordingQueryKey(orgId ?? '', sessionId ?? ''),
    queryFn: async (): Promise<RecordingStatus> =>
      wire(await apiClient.rtc.recording.status.query({ sessionId: sessionId ?? '' })),
    enabled: orgId !== null && sessionId !== null && status === 'in_call',
    refetchInterval: 2_000,
  });

  /* ## Ringback, and exactly when it plays — see web's identical, longer
   * comment on why `connectedAt === null` (never cleared until the call
   * itself ends) is the only correct signal for "still waiting for the
   * first answer", as opposed to "everyone already left" — both read
   * `peers.length === 0`, and only one of them should play a tone. */
  const waitingForFirstAnswer = status === 'in_call' && peers.length === 0 && connectedAt === null;
  const abandoned = status === 'in_call' && peers.length === 0 && connectedAt !== null;

  useEffect(() => {
    if (!waitingForFirstAnswer) return undefined;
    /* Same async-race guard as the incoming-ringtone effect above. */
    let cancelled = false;
    let ringing: Ringing | null = null;
    void startRingback().then((result) => {
      if (cancelled) {
        result.stop();
        return;
      }
      ringing = result;
    });
    return () => {
      cancelled = true;
      ringing?.stop();
    };
  }, [waitingForFirstAnswer]);

  /* Hanging up when the SERVER says the call is over — see web's identical,
     longer comment: `session.service.ts`'s `leaveSession` is the authority
     on when a call has actually ended, not a local guess from `peers`
     dropping to zero (a lone person left in a GROUP call is deliberately
     still "in" it). */
  useEffect(() => {
    return gatewaySocket.onCallEnded((message) => {
      const current = callStore.getState();
      if (current.sessionId !== message.sessionId) return;
      void hangUp().then(() => {
        if (orgId !== null)
          void invalidateCalls(queryClient, orgId, current.channelId ?? undefined);
      });
    });
  }, [orgId, queryClient]);

  if (status === 'idle' && evicted) {
    return (
      <View style={styles.noticeCard} pointerEvents="auto">
        <Text style={styles.noticeText}>
          The call ended — your access to that conversation changed.
        </Text>
        <Pressable onPress={clearEviction}>
          <Text style={styles.noticeDismiss}>Dismiss</Text>
        </Pressable>
      </View>
    );
  }

  if (status === 'idle' || sessionId === null) return null;

  const others = peers.map((peer) => personOf(peer.userId).label);
  const recordingState = recording.data?.state ?? 'none';

  return (
    <View style={styles.activeCard} pointerEvents="auto">
      {recordingState === 'pending' && (
        <RecordingConsentBar
          sessionId={sessionId}
          orgId={orgId}
          channelId={channelId}
          awaiting={recording.data?.awaiting ?? []}
          consented={recording.data?.consented ?? []}
        />
      )}

      <View style={styles.activeRow}>
        <View
          style={[
            styles.statusDot,
            status === 'connecting' || waitingForFirstAnswer || abandoned
              ? styles.statusDotPending
              : styles.statusDotLive,
          ]}
        />
        <View style={styles.activeInfo}>
          <Text style={styles.activeStatus} numberOfLines={1}>
            {status === 'connecting'
              ? 'Connecting…'
              : waitingForFirstAnswer
                ? 'Ringing…'
                : abandoned
                  ? 'Everyone else has left'
                  : `${others.join(', ')} · ${formatCallDuration(durationSeconds)}`}
          </Text>
          {recordingState === 'active' && (
            <Text style={styles.recordingIndicator}>● Recording</Text>
          )}
        </View>
        <Pressable
          style={styles.muteButton}
          onPress={() => {
            setSpeakerphone(!speakerOn);
          }}
        >
          <Text style={styles.muteButtonText}>{speakerOn ? '🔊' : '🔈'}</Text>
        </Pressable>
        <Pressable
          style={styles.muteButton}
          onPress={() => {
            setMuted(!muted);
          }}
        >
          <Text style={styles.muteButtonText}>{muted ? '🔇' : '🎙'}</Text>
        </Pressable>
        <Pressable
          style={styles.hangUpButton}
          onPress={() => {
            void hangUp().then(() => {
              if (orgId !== null) void invalidateCalls(queryClient, orgId, channelId ?? undefined);
            });
          }}
        >
          <Text style={styles.hangUpButtonText}>Hang up</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Recording consent (§3.9) — status and answer only, no request control.
 * See this file's own header on why.
 * -------------------------------------------------------------------------- */

function RecordingConsentBar({
  sessionId,
  orgId,
  channelId,
  awaiting,
  consented,
}: {
  readonly sessionId: string;
  readonly orgId: string | null;
  readonly channelId: string | null;
  readonly awaiting: readonly string[];
  readonly consented: readonly string[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { personOf } = useMembers();
  const selfId = useSession((state) => state.userId);
  const [busy, setBusy] = useState(false);

  const myTurn = selfId !== null && awaiting.includes(selfId);

  const answer = useMutation({
    mutationFn: async (agreed: boolean) => {
      setBusy(true);
      await apiClient.rtc.recording.answer.mutate({ sessionId, agreed });
    },
    onSettled: async () => {
      setBusy(false);
      if (orgId !== null)
        await invalidateCalls(queryClient, orgId, channelId ?? undefined, sessionId);
    },
  });

  return (
    <View style={styles.consentBar}>
      <View style={styles.consentInfo}>
        <Text style={styles.consentTitle}>
          {myTurn ? 'Record this call?' : 'Waiting for everyone to agree'}
        </Text>
        <Text style={styles.consentSubtitle} numberOfLines={1}>
          {consented.length} agreed
          {awaiting.length > 0 &&
            ` · waiting for ${awaiting.map((id) => personOf(id).label).join(', ')}`}
        </Text>
      </View>
      {myTurn && (
        <View style={styles.consentActions}>
          <Pressable
            style={styles.consentAgree}
            disabled={busy}
            onPress={() => {
              answer.mutate(true);
            }}
          >
            <Text style={styles.consentAgreeText}>Agree</Text>
          </Pressable>
          <Pressable
            style={styles.consentRefuse}
            disabled={busy}
            onPress={() => {
              answer.mutate(false);
            }}
          >
            <Text style={styles.consentRefuseText}>No</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    inset: 0,
    justifyContent: 'flex-end',
    alignItems: 'stretch',
    padding: 16,
    gap: 12,
  },
  bannerCard: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 6,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    height: 40,
    width: 40,
    borderRadius: 20,
    backgroundColor: colors.accent.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  bannerInfo: {
    flex: 1,
    gap: 2,
  },
  bannerName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  bannerSubtitle: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  bannerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  answerButton: {
    flex: 1,
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  answerButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  declineButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  declineButtonText: {
    color: colors.inkMuted.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  noticeCard: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    alignSelf: 'center',
  },
  noticeText: {
    fontSize: 13,
    color: colors.ink.hex,
    flexShrink: 1,
  },
  noticeDismiss: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    textDecorationLine: 'underline',
  },
  activeCard: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 6,
  },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  statusDot: {
    height: 9,
    width: 9,
    borderRadius: 5,
  },
  statusDotPending: {
    backgroundColor: colors.warning.hex,
  },
  statusDotLive: {
    backgroundColor: colors.success.hex,
  },
  activeInfo: {
    flex: 1,
    gap: 2,
  },
  activeStatus: {
    fontSize: 13,
    color: colors.ink.hex,
  },
  recordingIndicator: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  muteButton: {
    height: 32,
    width: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  muteButtonText: {
    fontSize: 15,
  },
  hangUpButton: {
    backgroundColor: colors.danger.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  hangUpButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  consentBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.warning.hex + '1a',
    borderBottomWidth: 1,
    borderBottomColor: colors.line.hex,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  consentInfo: {
    flex: 1,
    gap: 2,
  },
  consentTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  consentSubtitle: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  consentActions: {
    flexDirection: 'row',
    gap: 6,
  },
  consentAgree: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  consentAgreeText: {
    color: colors.accentInk.hex,
    fontSize: 12,
    fontWeight: '600',
  },
  consentRefuse: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  consentRefuseText: {
    color: colors.inkMuted.hex,
    fontSize: 12,
    fontWeight: '600',
  },
});
