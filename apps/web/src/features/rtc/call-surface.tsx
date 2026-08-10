import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { useToast } from '../../lib/toast-context.js';
import { onCallEnded, onIncomingCall } from '../../lib/socket.js';
import { cn } from '../../lib/cn.js';
import { Button } from '../../components/primitives.js';
import { useMembers } from '../org/use-members.js';
import { callPrefsQuery, incomingCallsQuery, invalidateCalls, recordingQuery } from './api.js';
import { startRingback, startRingtone, type Ringing } from './ringtone.js';
import {
  beginCapture,
  clearEviction,
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
  return (
    <>
      <IncomingCallBanner />
      <ActiveCallBar />
    </>
  );
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

  /* The live half. A `call:ringing` message means the poll's answer is already
     stale, so this refetches rather than inserting a row of its own — one
     source of truth for what is ringing, arrived at faster. */
  useEffect(() => {
    const offRinging = onIncomingCall(() => {
      void invalidateCalls(queryClient, orgId);
    });
    const offEnded = onCallEnded(() => {
      void invalidateCalls(queryClient, orgId);
    });
    return () => {
      offRinging();
      offEnded();
    };
  }, [orgId, queryClient]);

  /* The oldest ring wins. Stacking two banners is a decision about which is on
     top that nobody needs to make — the second call is still in the list and
     surfaces the moment the first is dealt with. */
  const call = (incoming.data ?? []).find((row) => row.sessionId !== currentSessionId);

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
      className="fixed bottom-4 right-4 z-50 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
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
            Incoming {call.kind === 'video' ? 'video' : 'voice'} call
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
          Cancel
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
   * same instant the person can actually hear them. */
  const waiting = status === 'in_call' && peers.length === 0;

  useEffect(() => {
    if (!waiting) return;
    const ringing = startRingback();
    return () => {
      ringing.stop();
    };
  }, [waiting]);

  /* The eviction notice outlives the call it refers to — `hangUp` preserves the
     flag precisely so this can still be shown after everything else is torn
     down. "You were removed from this conversation" is a very different thing
     from "the call dropped", and only the server knows which happened. */
  if (evicted && status === 'idle') {
    return (
      <div
        role="alert"
        className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-surface px-4 py-2 shadow-lg"
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
    );
  }

  if (status === 'idle' || sessionId === null) return null;

  const others = peers.map((peer) => personOf(peer.userId).label);
  const recordingState = recording.data?.state ?? 'none';

  return (
    <div className="fixed bottom-4 left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-surface shadow-2xl">
      {recordingState === 'pending' && (
        <RecordingConsentBar
          sessionId={sessionId}
          orgId={orgId}
          selfId={selfId}
          awaiting={recording.data?.awaiting ?? []}
          consented={recording.data?.consented ?? []}
        />
      )}

      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={cn(
            'flex h-2.5 w-2.5 shrink-0 rounded-full',
            status === 'connecting' || waiting ? 'animate-pulse bg-warning' : 'bg-success',
          )}
          aria-hidden="true"
        />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink">
            {status === 'connecting'
              ? 'Connecting…'
              : others.length === 0
                ? 'Ringing…'
                : others.join(', ')}
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
            state={recordingState}
            capturing={capturing}
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
  state,
  capturing,
}: {
  readonly sessionId: string;
  readonly orgId: string;
  readonly state: string;
  readonly capturing: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const request = useMutation({
    mutationFn: () => api.rtc.recording.request.mutate({ sessionId }),
    onSuccess: async () => {
      await invalidateCalls(queryClient, orgId, undefined, sessionId);
    },
    onError: (error) => {
      toast.failure('Recording could not be requested', error);
    },
  });

  const stop = useMutation({
    mutationFn: () => endCapture(),
    onSuccess: async () => {
      toast.show('Recording saved');
      await invalidateCalls(queryClient, orgId, undefined, sessionId);
    },
    onError: (error) => {
      /* The server has already been told to stop by `endCapture`, so the call
         is not still recording — what failed is the upload. Said plainly,
         because "recording failed" would suggest the audio is still being
         captured. */
      toast.failure('The recording was stopped but could not be saved', error);
      void invalidateCalls(queryClient, orgId, undefined, sessionId);
    },
  });

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
  selfId,
  awaiting,
  consented,
}: {
  readonly sessionId: string;
  readonly orgId: string;
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
      await invalidateCalls(queryClient, orgId, undefined, sessionId);
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
