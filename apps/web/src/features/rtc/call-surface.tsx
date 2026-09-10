import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { useToast } from '../../lib/toast-context.js';
import { onCallEnded, onIncomingCall } from '../../lib/socket.js';
import { cn } from '../../lib/cn.js';
import { formatCallDuration } from '../../lib/format.js';
import { Button } from '../../components/primitives.js';
import { useMembers } from '../org/use-members.js';
import { callPrefsQuery, incomingCallsQuery, invalidateCalls, recordingQuery } from './api.js';
import { startRingback, startRingtone, type Ringing } from './ringtone.js';
import {
  beginCapture,
  clearEviction,
  clearRecordingSaveError,
  endCapture,
  hangUp,
  joinCall,
  setMuted,
  useCallStore,
  type CallPeer,
} from './use-call.js';

/**
 * Everything about a call that must outlive the page it started on
 * (ai/phase-13-webrtc.md §7).
 *
 * Mounted once, in the app shell. A ringing call has to be answerable from
 * wherever somebody happens to be, and a call in progress has to survive
 * navigating away from the conversation — a microphone that stops when a route
 * unmounts is not a phone. That is the same reason `use-call.ts` keeps the call
 * in module state rather than in a component.
 *
 * ## The ring arrives on a socket and is CONFIRMED by a poll
 *
 * `onIncomingCall` is what makes the phone ring within milliseconds on any
 * page. `incomingCallsQuery` is what makes it ring at all if that message was
 * missed — a tab that was asleep, a reconnect mid-ring, a gateway restart. The
 * relationship is Phase 4's own: NOTIFY is the optimization, the poll is the
 * correctness guarantee. Delete the socket handler and calls still ring, six
 * seconds later; delete the poll and a dropped message is a call that never
 * rang.
 */
export function CallSurface() {
  useLeaveOnTabClose();

  return (
    <>
      <IncomingCallBanner />
      <ActiveCallBar />
    </>
  );
}

/**
 * A best-effort "I'm gone" on tab close, crash-adjacent navigation, or
 * putting the tab to sleep — the gap behind the "phantom beep" report: a
 * tab that just disappears (closed, not hung up) leaves this browser's own
 * mic open and, more importantly, its `rtc.participants` row `joined`
 * forever server-side, since nothing else in this app ever tells the API
 * that tab is gone. `apps/realtime`'s own disconnect handler cannot do this
 * instead — its file header is explicit that nothing in that namespace
 * writes to the database (guardrail 8); the write has to come from here.
 *
 * `pagehide`, not `beforeunload` — the latter also fires on a normal
 * back/forward-cache-eligible navigation and defeats bfcache in most
 * browsers just by being registered, which is a real performance cost to
 * pay on every navigation for a handler that only matters when a call is
 * live. `pagehide` fires in the same situations `beforeunload` does (tab
 * close, navigation, refresh) without that cost, and still fires when the
 * page is about to be frozen or discarded.
 *
 * This is NOT a substitute for a real reaper on the server: a genuine crash
 * (process killed, network severed with no chance to run JavaScript) fires
 * no browser event at all, and no client-side handler can close that gap.
 * What this closes is the much more common case — a tab closed or
 * navigated away from mid-call — which previously left the exact same
 * phantom session a true crash does.
 */
function useLeaveOnTabClose(): void {
  useEffect(() => {
    const onPageHide = (): void => {
      if (useCallStore.getState().sessionId === null) return;
      /* Not awaited — `pagehide` gives no time to wait for a network round
         trip, and the page may already be gone before this resolves. Best
         effort: it either lands before the tab finishes closing or it does
         not, the same honesty `hangUp`'s own leave-mutate call already has
         for every OTHER way it can fail. */
      void hangUp();
    };

    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);
}

/**
 * Forces a re-render once a second while `active`. Returns nothing —
 * callers recompute their own duration from a fixed instant on every tick,
 * which is simpler than threading a live number back through a second piece
 * of state that would need to stay in sync with the first.
 */
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

/**
 * Seconds since a captured instant, floored at zero.
 *
 * Kept as a plain function called FROM a render body rather than inlined —
 * `lib/format.ts`'s own note on `oooStatus` is the precedent: the React
 * Compiler's purity rule flags `Date.now()`/`new Date()` written directly in
 * a component or hook, and the clock has to live one call behind that.
 */
function elapsedSeconds(sinceMs: number): number {
  return Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
}

/* -------------------------------------------------------------------------- *
 * Ringing
 * -------------------------------------------------------------------------- */

function IncomingCallBanner() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const selfId = useSession((state) => state.userId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { personOf } = useMembers();
  const currentSessionId = useCallStore((state) => state.sessionId);

  const incoming = useQuery({ ...incomingCallsQuery(orgId), enabled: orgId !== '' });
  const prefs = useQuery({ ...callPrefsQuery(), enabled: orgId !== '' });

  /* The oldest ring wins. Stacking two banners is a decision about which is on
     top that nobody needs to make — the second call is still in the list and
     surfaces the moment the first is dealt with. */
  const call = (incoming.data ?? []).find((row) => row.sessionId !== currentSessionId);

  /* What the banner is CURRENTLY showing, kept in a ref rather than read from
     `call` inside the socket handler below — by the time `call:ended` fires,
     the invalidation it triggers may have already cleared `incoming.data`,
     and the toast needs to know who was calling a moment ago. */
  const shownCallRef = useRef(call);
  useEffect(() => {
    shownCallRef.current = call;
  }, [call]);

  /* Sessions this tab explicitly declined — so the `call:ended` broadcast
     that follows a decline (this tab is invited on it too) does not tell the
     person who just clicked "Decline" that they missed their own decision. */
  const selfDeclinedRef = useRef<Set<string>>(new Set());

  /* The live half. A `call:ringing` message means the poll's answer is already
     stale, so this refetches rather than inserting a row of its own — one
     source of truth for what is ringing, arrived at faster. */
  useEffect(() => {
    const offRinging = onIncomingCall(() => {
      void invalidateCalls(queryClient, orgId);
    });
    const offEnded = onCallEnded((message) => {
      const shown = shownCallRef.current;
      const wasAnswering = useCallStore.getState().sessionId === message.sessionId;
      const selfDeclined = selfDeclinedRef.current.delete(message.sessionId);

      /* A missed-call toast only when THIS banner was showing that exact
         call, this tab never answered it, and this tab is not the one that
         just declined it. Everything else — a call somebody else answered,
         a call this tab was never rung for — says nothing, because a toast
         about a call the viewer already knows the outcome of is noise. */
      if (shown?.sessionId === message.sessionId && !wasAnswering && !selfDeclined) {
        toast.show(`Missed call from ${personOf(shown.initiatedBy).label}`);
      }

      void invalidateCalls(queryClient, orgId);
    });
    return () => {
      offRinging();
      offEnded();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- personOf and toast are stable for the app's lifetime; re-subscribing on every render would tear down mid-ring
  }, [orgId, queryClient]);

  /* How long this has been ringing, for the receiver — ticks once a second
     while a call is shown. `call.createdAt` is the session's own creation
     instant, not "when this tab first noticed" — a tab that opens mid-ring
     (a reconnect, a second monitor) shows the call's real age, not zero. */
  useTicker(call !== undefined);
  const ringingSeconds =
    call === undefined ? 0 : elapsedSeconds(new Date(call.createdAt).getTime());

  /* ## The tone follows the call, not the render
   *
   * Keyed on the session id so a second call after the first is declined starts
   * a fresh tone, and so a re-render for any other reason does not restart the
   * cadence mid-ring. `ringEnabled` false gives the banner with no sound — an
   * open-plan office wants to be told without announcing it to the room, which
   * is why that preference is separate from muting notifications entirely. */
  const ringtone = prefs.data?.ringtone ?? 'classic';
  const ringEnabled = prefs.data?.ringEnabled ?? true;
  const ringingSessionId = call?.sessionId ?? null;

  useEffect(() => {
    if (ringingSessionId === null || !ringEnabled) return;

    const ringing: Ringing = startRingtone(ringtone);
    return () => {
      ringing.stop();
    };
  }, [ringingSessionId, ringEnabled, ringtone]);

  const answer = useMutation({
    mutationFn: async () => {
      if (call === undefined || selfId === null) return;
      await joinCall({
        orgId,
        sessionId: call.sessionId,
        channelId: call.channelId,
        selfId,
      });
    },
    onSuccess: async () => {
      await invalidateCalls(queryClient, orgId, call?.channelId);
    },
    onError: (error) => {
      toast.failure('The call could not be answered', error);
    },
  });

  const decline = useMutation({
    mutationFn: async () => {
      if (call === undefined) return;
      /* Recorded BEFORE the request, not in `onSuccess`: the `call:ended`
         broadcast this triggers can arrive before the mutation's own promise
         resolves, and the ref has to be marked in time to suppress it. */
      selfDeclinedRef.current.add(call.sessionId);
      await api.rtc.decline.mutate({ sessionId: call.sessionId });
    },
    onSuccess: async () => {
      await invalidateCalls(queryClient, orgId, call?.channelId);
    },
    onError: (error) => {
      toast.failure('The call could not be declined', error);
    },
  });

  if (call === undefined) return null;

  const caller = personOf(call.initiatedBy);
  const initials = caller.label.slice(0, 2).toUpperCase();

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-4 right-4 z-50 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
    >
      {/* A moving band rather than a static header. A ringing phone competes
          with whatever the person is reading, and motion is what wins that
          without the volume of a colour that shouts. */}
      <div className="h-1 w-full overflow-hidden bg-surface-sunken">
        <div className="h-full w-1/3 animate-[callring_1.6s_ease-in-out_infinite] bg-accent" />
      </div>

      <div className="flex items-center gap-3 p-4">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-ink">
          {initials}
          <span className="absolute inset-0 animate-ping rounded-full border-2 border-accent opacity-60" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{caller.label}</p>
          <p className="text-xs text-ink-faint">
            Incoming {call.kind === 'video' ? 'video' : 'voice'} call ·{' '}
            {formatCallDuration(ringingSeconds)}
            {ringEnabled ? '' : ' · silent'}
          </p>
        </div>
      </div>

      <div className="flex gap-2 border-t border-line p-3">
        <Button
          size="sm"
          variant="primary"
          className="flex-1"
          disabled={answer.isPending}
          onClick={() => {
            answer.mutate();
          }}
        >
          {answer.isPending ? 'Answering…' : '📞 Pick up'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="flex-1"
          disabled={decline.isPending}
          onClick={() => {
            decline.mutate();
          }}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * In a call
 * -------------------------------------------------------------------------- */

function ActiveCallBar() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const selfId = useSession((state) => state.userId);
  const queryClient = useQueryClient();
  const { personOf } = useMembers();

  const status = useCallStore((state) => state.status);
  const muted = useCallStore((state) => state.muted);
  const peers = useCallStore((state) => state.peers);
  const sessionId = useCallStore((state) => state.sessionId);
  const channelId = useCallStore((state) => state.channelId);
  const evicted = useCallStore((state) => state.evicted);
  const capturing = useCallStore((state) => state.capturing);
  const connectedAt = useCallStore((state) => state.connectedAt);
  const recordingSaveError = useCallStore((state) => state.recordingSaveError);

  useTicker(connectedAt !== null);
  const durationSeconds = connectedAt === null ? 0 : elapsedSeconds(connectedAt);

  const recording = useQuery({
    ...recordingQuery(orgId, sessionId ?? ''),
    enabled: orgId !== '' && sessionId !== null && status === 'in_call',
  });

  /* ## Ringback, and exactly when it plays
   *
   * While this tab is in a call that nobody else has joined yet. Not during
   * `connecting` — that is the local setup (permission prompt, ICE) and a tone
   * there would start before the far side has been told anything. The moment a
   * peer's audio arrives, `peers` is non-empty and the tone stops, which is the
   * same instant the person can actually hear them.
   *
   * ## "Nobody has answered yet" and "everyone already left" are NOT the same
   * state, even though `peers.length === 0` is true for both
   *
   * `connectedAt` is the tell: it is set once, on this tab's first genuine
   * remote peer, and never cleared until the call itself ends (see
   * `use-call.ts`'s own comment on it). So `connectedAt === null` can only
   * mean "still waiting for the first answer" — the ringback case — and
   * `connectedAt !== null` with an empty `peers` can only mean this tab WAS
   * actually talking to someone and now is not: for a 1:1 call the server
   * ends that session and the `onCallEnded` effect below hangs this tab up
   * before it is ever seen, but a GROUP call is deliberately left open at
   * one remaining person (`isLastLegOut` in `participants.ts`), so this
   * state is real and reachable. Playing the pre-answer ringback tone here
   * would be a lie — nobody is being rung — and showing "Ringing…" reads as
   * this tab failing to connect rather than what actually happened. */
  const waitingForFirstAnswer = status === 'in_call' && peers.length === 0 && connectedAt === null;
  const abandoned = status === 'in_call' && peers.length === 0 && connectedAt !== null;

  useEffect(() => {
    if (!waitingForFirstAnswer) return;
    const ringing = startRingback();
    return () => {
      ringing.stop();
    };
  }, [waitingForFirstAnswer]);

  /* ## Hanging up when the SERVER says the call is over
   *
   * `session.service.ts`'s `leaveSession` is the authority on when a call has
   * actually ended — a 1:1 call the moment either party leaves, a group call
   * only once everyone has — and it broadcasts `rtc_session.ended` as
   * `call:ended` when it decides that. This tab defers to that decision
   * rather than guessing from `peers.length` dropping to zero: a lone person
   * left in a GROUP call is deliberately still "in" it (they may be waiting
   * for someone to rejoin — the server does not end that session), and a
   * client-side guess based on peer count alone cannot tell that case apart
   * from a 1:1 call whose other party just left. Only the session that was
   * actually ended can.
   *
   * Without this, this tab's own `peers` reaching zero mid-call reads
   * identically to the pre-answer ring: `waiting` above goes true, the
   * ringback tone restarts, and the microphone stays live until the person
   * notices and clicks "Hang up" themselves. */
  useEffect(() => {
    return onCallEnded((message) => {
      /* Read fresh from the store rather than closing over the `channelId`
         variable above: this effect subscribes once (empty deps), so a
         closure would capture whatever call — or no call — was active on
         MOUNT, not the one this message is actually about. */
      const current = useCallStore.getState();
      if (current.sessionId !== message.sessionId) return;
      void hangUp().then(() => invalidateCalls(queryClient, orgId, current.channelId ?? undefined));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryClient/orgId are stable for this component's lifetime; the session/channel are read fresh from the store above
  }, []);

  /* Both notices outlive the call they refer to — `hangUp` preserves the
     flags precisely so either can still be shown after everything else is
     torn down. "You were removed from this conversation" and "the recording
     could not be saved" are both facts only the moment of hanging up knew,
     and there is no other surface left to say them from once the bar itself
     is gone. */
  if (status === 'idle' && (evicted || recordingSaveError !== null)) {
    return (
      <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
        {evicted && (
          <div
            role="alert"
            className="rounded-lg border border-line bg-surface px-4 py-2 shadow-lg"
          >
            <span className="text-sm text-ink">
              The call ended — your access to that conversation changed.
            </span>
            <button
              type="button"
              onClick={clearEviction}
              className="ml-3 text-xs text-ink-muted underline hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        )}
        {recordingSaveError !== null && (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-2 shadow-lg"
          >
            <span className="text-sm text-ink">{recordingSaveError}</span>
            <button
              type="button"
              onClick={clearRecordingSaveError}
              className="ml-3 text-xs text-ink-muted underline hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  if (status === 'idle' || sessionId === null) return null;

  const others = peers.map((peer) => personOf(peer.userId).label);
  const recordingState = recording.data?.state ?? 'none';

  return (
    <div className="fixed bottom-4 left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-surface shadow-lg">
      {recordingState === 'pending' && (
        <RecordingConsentBar
          sessionId={sessionId}
          orgId={orgId}
          channelId={channelId}
          selfId={selfId}
          awaiting={recording.data?.awaiting ?? []}
          consented={recording.data?.consented ?? []}
        />
      )}

      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={cn(
            'flex h-2.5 w-2.5 shrink-0 rounded-full',
            status === 'connecting' || waitingForFirstAnswer || abandoned
              ? 'animate-pulse bg-warning'
              : 'bg-success',
          )}
          aria-hidden="true"
        />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink">
            {status === 'connecting'
              ? 'Connecting…'
              : waitingForFirstAnswer
                ? 'Ringing…'
                : abandoned
                  ? 'Everyone else has left'
                  : `${others.join(', ')} · ${formatCallDuration(durationSeconds)}`}
          </p>
          {recordingState === 'active' && (
            /* Every participant sees this, not only the person capturing. A
               recording indicator visible to one side is not a consent
               mechanism, it is a decoration. */
            <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />
              Recording
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            label={muted ? 'Unmute' : 'Mute'}
            active={muted}
            onClick={() => {
              setMuted(!muted);
            }}
          >
            {muted ? '🔇' : '🎙'}
          </IconButton>

          <RecordButton
            sessionId={sessionId}
            orgId={orgId}
            channelId={channelId}
            state={recordingState}
            capturing={capturing}
            /* The server refuses recording while the session is still
               ringing (`requestRecording` requires status 'active'), so a
               button shown before the first answer is a CTA whose only
               outcome is a 409 — the exact "why show me this if I can't do
               it" failure this file is built to avoid. Hidden until the
               first remote peer connects, which is the same instant the
               session flips to 'active' server-side. */
            connected={!waitingForFirstAnswer}
          />

          <Button
            size="sm"
            variant="primary"
            className="bg-danger! text-white!"
            onClick={() => {
              void hangUp().then(() => invalidateCalls(queryClient, orgId, channelId ?? undefined));
            }}
          >
            Hang up
          </Button>
        </div>
      </div>

      {peers.map((peer) => (
        <RemoteAudio key={peer.userId} peer={peer} />
      ))}

      {/* Announced to assistive technology separately from the visual dot.
          A screen-reader user gets no benefit from a pulsing red circle, and
          "this call is being recorded" is the one thing in this bar that is
          not optional to convey. `polite` rather than `assertive` because it
          arrives alongside a visible change nobody is going to miss. */}
      <span className="sr-only" aria-live="polite">
        {recordingState === 'active' ? 'This call is being recorded' : ''}
      </span>
    </div>
  );
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-sm',
        active === true
          ? 'bg-accent text-accent-ink'
          : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- *
 * Recording (§3.9)
 * -------------------------------------------------------------------------- */

/**
 * Ask / start / stop, in one control whose caption follows the SERVER's state.
 *
 * Not local state: the session's `recordingState` is shared by everyone in the
 * call, and a button that tracked its own idea of it would let two people each
 * think they were the one recording.
 */
function RecordButton({
  sessionId,
  orgId,
  channelId,
  state,
  capturing,
  connected,
}: {
  readonly sessionId: string;
  readonly orgId: string;
  readonly channelId: string | null;
  readonly state: string;
  readonly capturing: boolean;
  /** False while the call is still ringing — the record button is not
      shown until somebody has actually answered. */
  readonly connected: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const request = useMutation({
    mutationFn: () => api.rtc.recording.request.mutate({ sessionId }),
    onSuccess: async () => {
      await invalidateCalls(queryClient, orgId, channelId ?? undefined, sessionId);
    },
    onError: (error) => {
      toast.failure('Recording could not be requested', error);
    },
  });

  const stop = useMutation({
    mutationFn: () => endCapture(),
    onSuccess: async () => {
      toast.show('Recording saved');
      /* The channel's own recording list is what closes the "started a
         recording, cannot see it anywhere" gap — without `channelId` here,
         `invalidateCalls` skips `rtcKeys.recordings` entirely (see its own
         header) and the Calls tab keeps showing whatever it last loaded
         until something unrelated happens to refetch it. */
      await invalidateCalls(queryClient, orgId, channelId ?? undefined, sessionId);
    },
    onError: (error) => {
      /* The server has already been told to stop by `endCapture`, so the call
         is not still recording — what failed is the upload. Said plainly,
         because "recording failed" would suggest the audio is still being
         captured. */
      toast.failure('The recording was stopped but could not be saved', error);
      void invalidateCalls(queryClient, orgId, channelId ?? undefined, sessionId);
    },
  });

  /* Not shown while the call is still ringing, or after everyone else has
     left — see the caller's comment on `connected`. The server is still the
     gate (`requestRecording` requires the session to be 'active'); this
     merely stops offering an action that could only fail. */
  if (!connected) return null;

  if (state === 'active') {
    /* Only the tab that pressed start holds the MediaRecorder, so only it can
       finish the upload. Everyone else sees the indicator and no button —
       hiding it is honest, because pressing it there could not produce a file. */
    if (!capturing) return null;

    return (
      <IconButton
        label="Stop recording"
        active
        onClick={() => {
          stop.mutate();
        }}
      >
        ⏹
      </IconButton>
    );
  }

  if (state === 'pending') {
    return <span className="px-1 text-xs text-ink-faint">Asking…</span>;
  }

  return (
    <IconButton
      label="Record this call"
      onClick={() => {
        request.mutate();
      }}
    >
      ⏺
    </IconButton>
  );
}

/**
 * "May we record this?" — shown to everyone in the call while consent is open.
 *
 * ## The person who asked does not see a button
 *
 * Their consent was recorded server-side when they made the request
 * (`requestRecording`). Asking somebody to click "agree" on their own request
 * is ceremony, and ceremony is what teaches people to click through consent
 * dialogs without reading them.
 *
 * ## Anybody may refuse, including an owner's request
 *
 * There is no permission that overrides this. A capability that let an admin
 * record over an objection would make the gate decorative, and the org's own
 * admin is exactly who somebody most needs to be able to refuse.
 */
function RecordingConsentBar({
  sessionId,
  orgId,
  channelId,
  selfId,
  awaiting,
  consented,
}: {
  readonly sessionId: string;
  readonly orgId: string;
  readonly channelId: string | null;
  readonly selfId: string | null;
  readonly awaiting: readonly string[];
  readonly consented: readonly string[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { personOf } = useMembers();
  const [busy, setBusy] = useState(false);

  const myTurn = selfId !== null && awaiting.includes(selfId);

  const answer = useMutation({
    mutationFn: async (agreed: boolean) => {
      setBusy(true);
      await api.rtc.recording.answer.mutate({ sessionId, agreed });

      /* The person who ASKED is the one that starts capture, and only once
         nobody is left to ask. Attempted by everybody who answers, and refused
         by the server for anyone who is not the requester — which is cheaper
         and more reliable than each client working out whose job it is. */
      if (agreed && awaiting.length <= 1) {
        await beginCapture().catch(() => undefined);
      }
    },
    onSettled: async () => {
      setBusy(false);
      await invalidateCalls(queryClient, orgId, channelId ?? undefined, sessionId);
    },
    onError: (error) => {
      toast.failure('Your answer was not recorded', error);
    },
  });

  return (
    <div className="flex items-center gap-3 rounded-t-xl border-b border-line bg-warning/10 px-4 py-2.5">
      <span aria-hidden="true">⏺</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-ink">
          {myTurn ? 'Record this call?' : 'Waiting for everyone to agree'}
        </p>
        <p className="truncate text-[11px] text-ink-faint">
          {consented.length} agreed
          {awaiting.length > 0 &&
            ` · waiting for ${awaiting.map((id) => personOf(id).label).join(', ')}`}
        </p>
      </div>

      {myTurn && (
        <div className="flex shrink-0 gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => {
              answer.mutate(true);
            }}
          >
            Agree
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              answer.mutate(false);
            }}
          >
            No
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One peer's audio.
 *
 * An `<audio>` element rather than a Web Audio graph: a graph would allow
 * per-peer volume, and it would also mean reimplementing playback, device
 * routing and autoplay handling the element already does correctly.
 *
 * `srcObject` is set through a ref because it takes a `MediaStream`, not a URL —
 * there is no attribute form of it, so React cannot set it as a prop.
 */
function RemoteAudio({ peer }: { readonly peer: CallPeer }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.srcObject = peer.stream;

    /* Autoplay can be refused. This element is created in response to a click
       (answering or starting a call), which is the gesture browsers require —
       but a tab restored from bfcache has no gesture, and a rejected promise
       here would be an unhandled rejection in the console rather than a silent,
       recoverable "no audio until the next interaction". */
    void element.play().catch(() => undefined);
  }, [peer.stream]);

  return <audio ref={ref} autoPlay className="hidden" />;
}
