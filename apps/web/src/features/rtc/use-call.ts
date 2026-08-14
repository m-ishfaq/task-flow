import { create } from 'zustand';
import { api } from '../../lib/trpc.js';
import {
  joinCallRoom,
  leaveCallRoom,
  onCallRoomClosed,
  onPeers,
  onSignal,
  sendSignal,
} from '../../lib/rtc-socket.js';
import { PeerMesh } from './peer-mesh.js';
import { canRecord, startCallRecorder, type CallRecorder } from './call-recorder.js';

/**
 * The one live call this tab is in (ai/phase-13-webrtc.md §3.1).
 *
 * ## Why this is a store and not a hook's local state
 *
 * A call outlives the component that started it. Someone answers from the
 * ringing banner in the app shell, navigates to a board, and the call must keep
 * going — a microphone that stops when a route unmounts is not a phone. So the
 * call lives in module state with a Zustand view for rendering, exactly the
 * reason `lib/socket.ts` keeps the connection at module scope.
 *
 * ## One call at a time, and it is enforced here
 *
 * Joining a second call hangs up the first. The alternative is two open
 * microphones and two sets of peer connections competing for the same audio
 * device, which browsers handle badly and users cannot reason about at all.
 *
 * ## The order of operations in `join` is the interesting part
 *
 *   1. `rtc.join` (HTTP)      — the AUTHORITATIVE decision and the call record.
 *   2. `rtc.iceServers` (HTTP)— the spend gate; may refuse after (1) allowed.
 *   3. `getUserMedia`         — the permission prompt, only once the server said yes.
 *   4. `rtc:join` (socket)    — the signalling room.
 *   5. `setPeers` on the roster.
 *
 * (3) after (1) and (2) deliberately: asking for someone's microphone and THEN
 * telling them the call is full is a worse experience than the reverse, and a
 * browser that has been granted the mic keeps the indicator lit until every
 * track is stopped. (4) last, so no signal can arrive before there is a mesh to
 * hand it to.
 */

export interface CallPeer {
  readonly userId: string;
  readonly stream: MediaStream;
}

export interface CallState {
  readonly sessionId: string | null;
  readonly channelId: string | null;
  readonly orgId: string | null;
  readonly status: 'idle' | 'connecting' | 'in_call';
  readonly muted: boolean;
  /** Remote audio, keyed by peer. Rendered as one `<audio>` per entry. */
  readonly peers: readonly CallPeer[];
  /** Set when the gateway evicted this tab mid-call (a grant changed). */
  readonly evicted: boolean;
  /**
   * True while THIS tab is the one capturing (§3.9).
   *
   * Distinct from the session's `recordingState`, which is the shared fact
   * every participant sees. Only the tab that pressed start holds a
   * `MediaRecorder`, and only it can finish the upload — conflating the two
   * would make every participant's UI think it had a file to send.
   */
  readonly capturing: boolean;
  /**
   * `Date.now()` of the first remote audio this tab received, or null before
   * that. What the active-call bar's duration timer counts from.
   *
   * Not "when `status` became `in_call`": that flips the instant the local
   * `getUserMedia`/signalling handshake finishes, which for the answering
   * side can be well before the other party's audio actually arrives, and
   * for the calling side is the moment ringing STARTS, not when anyone
   * picked up (`waiting` below is already the ringback signal for that gap).
   * A duration that started counting during the ring would read as the call
   * having lasted longer than anyone was actually talking.
   */
  readonly connectedAt: number | null;
  /**
   * Set when `hangUp` finished an in-progress recording and the upload
   * failed. Outlives the call it refers to, the same way `evicted` does —
   * the banner that reports it renders after `status` is already back to
   * `idle`, and by then there is no other surface left to say the file did
   * not make it.
   */
  readonly recordingSaveError: string | null;
}

const IDLE: CallState = {
  sessionId: null,
  channelId: null,
  orgId: null,
  status: 'idle',
  muted: false,
  peers: [],
  evicted: false,
  capturing: false,
  connectedAt: null,
  recordingSaveError: null,
};

export const useCallStore = create<CallState>(() => IDLE);

/* Module-scope, not in the store: these are resources, not rendered state, and
   putting a MediaStream in a store invites a component to re-render on every
   track event. */
let mesh: PeerMesh | null = null;
let localStream: MediaStream | null = null;
let recorder: CallRecorder | null = null;
let unsubscribers: (() => void)[] = [];

function setPeer(userId: string, stream: MediaStream): void {
  useCallStore.setState((state) => ({
    peers: [...state.peers.filter((peer) => peer.userId !== userId), { userId, stream }],
    /* Set once, on the FIRST remote stream — a second or third peer joining a
       group call must not restart the clock for everyone already talking. */
    connectedAt: state.connectedAt ?? Date.now(),
  }));

  /* A peer that arrives DURING capture joins the mix. Reachable because a join
     pauses recording (the consent counter in migration 0042) and it resumes
     only once they agree — so a stream added here always belongs to somebody
     who has consented. */
  recorder?.addStream(stream);
}

function dropPeer(userId: string): void {
  useCallStore.setState((state) => ({
    peers: state.peers.filter((peer) => peer.userId !== userId),
  }));
}

/**
 * Guards two `joinCall` invocations racing to completion — most concretely,
 * answering a second incoming call while the first is still sitting on the
 * microphone permission prompt. Bumped once per invocation; a step that
 * resolves after a NEWER call has already taken over the module-level
 * `mesh`/`localStream`/`unsubscribers` must not touch them — the newer call
 * already owns cleanup, and touching them here is how a stale
 * `getUserMedia()` reply used to leak a microphone the user thinks is off,
 * or tear down a mesh the newer call had just built.
 */
let generation = 0;

/**
 * Races a promise against a timer. Exists because two of `joinCall`'s steps
 * have no timeout of their own: `joinCallRoom`'s ack-wait resolves its
 * promise only on a reply that, if the socket never delivers it, simply
 * never arrives, and a bare fetch has no deadline either — both read from
 * the UI as "Connecting…" forever with no way out, which is exactly the
 * "shows connecting long after call is placed" report.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${step}.`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const STEP_TIMEOUT_MS = 15_000;
/* Generous, and deliberately not the same budget as the network steps above:
   this one is waiting on a PERSON, not a server, and must not fire while a
   permission dialog is legitimately still open on screen. It exists only as
   a last-resort escape from a browser that never resolves the promise at
   all, not as a UX nudge. */
const MIC_TIMEOUT_MS = 120_000;

/**
 * Joins (or answers) a call.
 *
 * Throws whatever the server said. Callers surface it in a toast rather than
 * this module doing it, for the reason `call-button.tsx` gives about telephony:
 * the UI never re-derives authorization, it reports what the server answered.
 *
 * A call superseded by a newer `joinCall` mid-flight (see `generation` above)
 * resolves quietly instead — it was never an error, just overtaken.
 */
export async function joinCall(input: {
  readonly orgId: string;
  readonly sessionId: string;
  readonly channelId: string;
  readonly selfId: string;
}): Promise<void> {
  const myGeneration = ++generation;

  /* One call at a time — see the header. */
  if (useCallStore.getState().sessionId !== null) await hangUp();
  if (myGeneration !== generation) return;

  useCallStore.setState({
    sessionId: input.sessionId,
    channelId: input.channelId,
    orgId: input.orgId,
    status: 'connecting',
    muted: false,
    peers: [],
    evicted: false,
    capturing: false,
    connectedAt: null,
    recordingSaveError: null,
  });

  /* Tracked locally, separately from the module-level `localStream`, so a
     superseded attempt can release the mic IT acquired without guessing
     whether the shared variable still points at its stream or a newer
     call's. */
  let ownedStream: MediaStream | null = null;

  try {
    await withTimeout(
      api.rtc.join.mutate({ sessionId: input.sessionId }),
      STEP_TIMEOUT_MS,
      'the call to be accepted',
    );
    if (myGeneration !== generation) return;

    const ice = await withTimeout(
      api.rtc.iceServers.mutate({ sessionId: input.sessionId }),
      STEP_TIMEOUT_MS,
      'call credentials',
    );
    if (myGeneration !== generation) return;

    /* Only now. See the header on why the microphone prompt comes third. */
    ownedStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
      MIC_TIMEOUT_MS,
      'microphone access',
    );
    if (myGeneration !== generation) {
      for (const track of ownedStream.getTracks()) track.stop();
      return;
    }
    localStream = ownedStream;

    mesh = new PeerMesh({
      selfId: input.selfId,
      localStream,
      configuration: {
        iceServers: ice.iceServers.map((server) => ({
          urls: [...server.urls],
          ...(server.username === undefined ? {} : { username: server.username }),
          ...(server.credential === undefined ? {} : { credential: server.credential }),
        })),
        iceTransportPolicy: ice.iceTransportPolicy,
      },
      transport: {
        send: (to, kind, data) => {
          sendSignal(input.sessionId, to, kind, data);
        },
      },
      onRemoteStream: setPeer,
      onPeerGone: dropPeer,
    });

    unsubscribers = [
      onSignal((message) => {
        if (message.sessionId !== input.sessionId) return;
        void mesh?.handleSignal(message.from, message.kind, message.data);
      }),
      onPeers((message) => {
        if (message.sessionId !== input.sessionId) return;
        mesh?.setPeers(message.userIds);
      }),
      onCallRoomClosed((message) => {
        if (message.sessionId !== input.sessionId) return;
        /* The gateway evicted this tab: a grant changed underneath a live call
           (`applyRtcRevocation`). Recorded rather than silently hung up so the
           UI can say why the call ended — "you were removed from this
           conversation" is a very different thing from "the call dropped". */
        useCallStore.setState({ evicted: true });
        void hangUp();
      }),
    ];

    /* Last, so no signal can arrive before there is a mesh to hand it to. */
    const admitted = await withTimeout(
      joinCallRoom(input.orgId, input.sessionId),
      STEP_TIMEOUT_MS,
      'the signalling room',
    );
    if (myGeneration !== generation) return;
    if (!admitted) throw new Error('The call could not be joined.');

    useCallStore.setState({ status: 'in_call' });
  } catch (error) {
    if (myGeneration === generation) {
      /* Everything acquired so far is released, including the microphone. A
         failed join that leaves the mic indicator lit is the single most
         alarming way for this feature to break. */
      await hangUp({ silent: true });
    } else if (ownedStream !== null && localStream !== ownedStream) {
      /* Superseded before `hangUp` (run by the newer call) had a chance to
         see this stream as the active one — release it directly. Stopping
         an already-stopped track is a harmless no-op, so this is safe even
         when the newer call's own `hangUp` got there first. */
      for (const track of ownedStream.getTracks()) track.stop();
    }
    throw error;
  }
}

/** Leaves the call and releases every resource. Safe to call when idle. */
export async function hangUp(options: { readonly silent?: boolean } = {}): Promise<void> {
  const { sessionId, evicted } = useCallStore.getState();

  /**
   * A recording in progress is FINISHED here, not discarded.
   *
   * This used to abandon the capture on the reasoning that "the person who
   * wants the file presses stop, which uploads it" — but hanging up IS how
   * most people end a call, and losing a recording somebody explicitly
   * started because they pressed "Hang up" instead of a second, separate
   * "Stop recording" button first is a worse failure than uploading a
   * capture nobody pressed an extra button to keep. They can still delete
   * it afterward; a discarded recording cannot be gotten back.
   *
   * Done BEFORE the mesh and local tracks are torn down: the recorder's
   * audio graph is built from those streams (`call-recorder.ts`), and
   * stopping them first would capture silence for the last moment instead
   * of whatever was actually said right up to hanging up.
   */
  let recordingSaveError: string | null = null;
  if (recorder !== null) {
    try {
      await finishCapture(sessionId);
    } catch {
      /* Best-effort by necessity — the mic and the call still have to be
         released below regardless of whether the upload succeeded. Recorded
         so `ActiveCallBar` can tell the person afterward, the same way
         `evicted` survives past the reset to explain an otherwise-silent
         call ending. */
      recordingSaveError = 'The recording could not be saved.';
    }
  }

  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];

  mesh?.close();
  mesh = null;

  /* Every track, explicitly. A MediaStream that is merely dereferenced keeps
     the device open until garbage collection, so the browser's recording
     indicator stays lit after the call ends — which reads as "this app is
     still listening". */
  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;

  if (sessionId !== null) {
    leaveCallRoom(sessionId);
    if (options.silent !== true) {
      /* Best-effort. The server's own bookkeeping is what ends the call, and a
         failure here (offline, tab closing) must not stop the local teardown
         above — which has already happened. */
      await api.rtc.leave.mutate({ sessionId }).catch(() => undefined);
    }
  }

  useCallStore.setState({ ...IDLE, evicted, recordingSaveError });
}

/** Acknowledges the eviction notice, so the banner can be dismissed. */
export function clearEviction(): void {
  useCallStore.setState({ evicted: false });
}

/** Acknowledges the recording-save-failed notice, so the banner can be
    dismissed. */
export function clearRecordingSaveError(): void {
  useCallStore.setState({ recordingSaveError: null });
}

/* -------------------------------------------------------------------------- *
 * Recording (§3.9)
 * -------------------------------------------------------------------------- */

/**
 * Starts capturing, once the server says everyone has agreed.
 *
 * The ORDER is the control, and it is the same shape the server's own three
 * layers take: `rtc.recording.start` is called FIRST and can refuse — the
 * database's `sessions_recording_needs_consent` is what makes that refusal
 * real — and only a successful reply creates a `MediaRecorder`. A capture
 * started optimistically and torn down on failure would have recorded, however
 * briefly, without consent.
 */
export async function beginCapture(): Promise<void> {
  const { sessionId, peers } = useCallStore.getState();
  if (sessionId === null || localStream === null || recorder !== null) return;

  if (!canRecord()) {
    throw new Error('This browser cannot record calls.');
  }

  const { recordingId } = await api.rtc.recording.start.mutate({ sessionId });

  const started = startCallRecorder({
    recordingId,
    localStream,
    remoteStreams: peers.map((peer) => peer.stream),
  });

  if (started === null) {
    /* The capability check above passed and construction still failed. Tell the
       server to stop, so the session does not sit in `active` recording with
       nobody recording — which would show every other participant a red dot
       for a file that will never exist. */
    await api.rtc.recording.stop.mutate({ sessionId }).catch(() => undefined);
    throw new Error('This browser cannot record calls.');
  }

  recorder = started;
  useCallStore.setState({ capturing: true });
}

/**
 * Stops capture and uploads.
 *
 * The server is told FIRST, so every other participant's indicator goes out
 * immediately rather than after an upload that may take a while. The upload
 * failing afterwards leaves a `pending` recording row and a thrown error for
 * the caller to report — never a session that still claims to be recording.
 *
 * Shared with `hangUp`, which finishes an in-progress recording rather than
 * discarding it — see that function's own header.
 */
async function finishCapture(sessionId: string | null): Promise<void> {
  const active = recorder;
  recorder = null;
  useCallStore.setState({ capturing: false });

  if (sessionId !== null) {
    await api.rtc.recording.stop.mutate({ sessionId }).catch(() => undefined);
  }
  if (active === null) return;

  await active.finish();
}

/** Stops capture and uploads — the explicit "Stop recording" button. */
export async function endCapture(): Promise<void> {
  const { sessionId } = useCallStore.getState();
  await finishCapture(sessionId);
}

/**
 * Mutes or unmutes the microphone.
 *
 * `track.enabled = false` rather than removing the track: removing it forces a
 * renegotiation with every peer, which in a mesh means N offers to say "I am not
 * talking right now". Disabling keeps the transceiver and sends silence.
 *
 * Stated honestly: this is a mute, not a hardware cutoff. The browser's own
 * recording indicator stays lit, and that is correct — the page still holds the
 * device. Only `hangUp` releases it.
 */
export function setMuted(muted: boolean): void {
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
  useCallStore.setState({ muted });
}
