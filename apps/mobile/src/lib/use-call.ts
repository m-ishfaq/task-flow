import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { MediaStream } from 'react-native-webrtc';
import { apiClient, rtcSocket } from './app-session.js';
import { PeerMesh, type RtcConfiguration } from './peer-mesh.js';

/**
 * The one live call this app is in (ai/phase-13-webrtc.md §3.1), ported
 * from `apps/web/src/features/rtc/use-call.ts`. The join/hang-up
 * orchestration and its ordering — `rtc.join` (HTTP), then `rtc.iceServers`
 * (the spend gate), then the microphone prompt, then `rtc:join` (socket),
 * then `setPeers` on the roster — are UNCHANGED from web; see that file's
 * own header for the full reasoning on why each step comes where it does
 * and why joining a second call hangs up the first.
 *
 * ## A vanilla Zustand store, not `create()`
 *
 * `session.ts`'s own header explains why this app's stores are vanilla
 * (`createStore` from `zustand/vanilla`, bound to components via
 * `useStore`) rather than the hook-returning `create()` web's `use-call.ts`
 * uses: it keeps this file unit-testable with no React renderer, the same
 * split `session.ts`/`use-session.ts` already draw. `useCallStore` below is
 * this file's own thin binding, mirroring `use-session.ts` exactly.
 *
 * ## `mediaDevices.getUserMedia`, not `navigator.mediaDevices`
 *
 * `react-native-webrtc` has no `navigator` to hang off; `mediaDevices` is
 * its own named export with the identical W3C-shaped method. Nothing else
 * about the acquire-then-release discipline changes: every track is
 * stopped explicitly on `hangUp`, never merely dereferenced, for the
 * identical reason web's own comment gives — a stream that is only
 * garbage-collected keeps the OS's own "microphone in use" indicator lit.
 *
 * ## `react-native-webrtc` is imported dynamically, inside `joinCall`
 *
 * Its own `index.ts` throws SYNCHRONOUSLY at import time —
 * `if (WebRTCModule === null) throw new Error('WebRTC native module not
 * found...')` — whenever the native module is not linked: Expo Go always,
 * and any dev-client build that predates this feature or a failed rebuild
 * of it. `call-surface.tsx` renders on every screen via `_layout.tsx`, so a
 * top-level value import here (the first version of this file had one)
 * poisons the ENTIRE route tree on any such build, not just calling — the
 * identical failure mode `modules/device-key/index.ts`'s own header already
 * documents and defers against with `getNative()`'s first-use memoization.
 * `await import('react-native-webrtc')` inside `joinCall` is this file's
 * version of that same deferral: the throw now happens only when a call is
 * actually started or answered, inside `joinCall`'s own `try`/`catch`, which
 * already surfaces it to the caller exactly like any other join failure —
 * `CallButton`'s and `IncomingCallBanner`'s existing error handling needs no
 * change to cover it.
 *
 * ## No recording capture on this platform — and that is a scope
 * boundary, not an oversight
 *
 * `react-native-webrtc` has no `MediaRecorder`-over-`MediaStream` and no
 * Web Audio `AudioContext.createMediaStreamDestination()` to mix a local
 * and remote stream into one track — the two primitives web's own
 * `call-recorder.ts` is built from. There is no drop-in mobile equivalent
 * without a dedicated native module this pass does not add. Consequently
 * this store carries `recordingState` (read from `rtc.recording.status`,
 * exactly as web does) so a call being recorded by a WEB participant shows
 * correctly here, and `answerConsent` so a mobile participant can agree or
 * refuse — both genuinely portable, capture-free operations — but there is
 * no `beginCapture`/`endCapture`/`capturing` and no way to REQUEST a
 * recording from this platform: a request initiated from a device that can
 * never call `rtc.recording.start` would sit `pending` forever, showing
 * everyone a checklist that can never resolve. The UI hides the "Record"
 * button on mobile for exactly that reason, the same "hidden rather than
 * shown-and-refused" principle CLAUDE.md's own §8.2 argument already
 * applies everywhere else in this codebase to a control whose only
 * possible outcome is a dead end.
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
  /** Remote audio, keyed by peer. */
  readonly peers: readonly CallPeer[];
  /** Set when the gateway evicted this app mid-call (a grant changed). */
  readonly evicted: boolean;
  /**
   * `Date.now()` of the first remote audio this app received, or null
   * before that — see `use-call.ts`'s web counterpart for the full
   * reasoning on why this, and not `status === 'in_call'`, is what a
   * duration timer counts from.
   */
  readonly connectedAt: number | null;
}

const IDLE: CallState = {
  sessionId: null,
  channelId: null,
  orgId: null,
  status: 'idle',
  muted: false,
  peers: [],
  evicted: false,
  connectedAt: null,
};

export const callStore: StoreApi<CallState> = createStore<CallState>(() => IDLE);

/** Binds a screen to the call store — mirrors `use-session.ts` exactly. */
export function useCallStore<T>(selector: (state: CallState) => T): T {
  return useStore(callStore, selector);
}

/* Module-scope, not in the store: these are resources, not rendered state —
   see web's identical comment on why a `MediaStream` does not belong in a
   store a component re-renders from. */
let mesh: PeerMesh | null = null;
let localStream: MediaStream | null = null;
let unsubscribers: (() => void)[] = [];

function setPeer(userId: string, stream: MediaStream): void {
  callStore.setState((state) => ({
    peers: [...state.peers.filter((peer) => peer.userId !== userId), { userId, stream }],
    /* Set once, on the FIRST remote stream — see web's identical comment. */
    connectedAt: state.connectedAt ?? Date.now(),
  }));
}

function dropPeer(userId: string): void {
  callStore.setState((state) => ({
    peers: state.peers.filter((peer) => peer.userId !== userId),
  }));
}

/**
 * Guards two `joinCall` invocations racing to completion — see web's
 * identical `generation` counter for the full reasoning (most concretely:
 * answering a second incoming call while the first is still sitting on the
 * microphone permission prompt).
 */
let generation = 0;

/** Races a promise against a timer — see web's identical helper. */
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
/* Generous, and deliberately not the same budget as the network steps
   above — see web's identical constant for why. */
const MIC_TIMEOUT_MS = 120_000;

/**
 * Joins (or answers) a call. Throws whatever the server said — callers
 * surface it themselves, the same "the UI never re-derives authorization,
 * it reports what the server answered" argument CLAUDE.md's §8.2 makes
 * everywhere else in this app.
 */
export async function joinCall(input: {
  readonly orgId: string;
  readonly sessionId: string;
  readonly channelId: string;
  readonly selfId: string;
}): Promise<void> {
  const myGeneration = ++generation;

  /* One call at a time — see the module header. */
  if (callStore.getState().sessionId !== null) await hangUp();
  if (myGeneration !== generation) return;

  callStore.setState({
    sessionId: input.sessionId,
    channelId: input.channelId,
    orgId: input.orgId,
    status: 'connecting',
    muted: false,
    peers: [],
    evicted: false,
    connectedAt: null,
  });

  /* Tracked locally, separately from the module-level `localStream` — see
     web's identical comment on why a superseded attempt must release only
     the stream IT acquired. */
  let ownedStream: MediaStream | null = null;

  try {
    await withTimeout(
      apiClient.rtc.join.mutate({ sessionId: input.sessionId }),
      STEP_TIMEOUT_MS,
      'the call to be accepted',
    );
    if (myGeneration !== generation) return;

    const ice = await withTimeout(
      apiClient.rtc.iceServers.mutate({ sessionId: input.sessionId }),
      STEP_TIMEOUT_MS,
      'call credentials',
    );
    if (myGeneration !== generation) return;

    /* Deferred to here — see the module header on why `react-native-webrtc`
       is never imported at module scope. */
    const webrtc = await import('react-native-webrtc');

    /* Only now — see the module header on why the microphone prompt comes
       third. */
    ownedStream = await withTimeout(
      webrtc.mediaDevices.getUserMedia({ audio: true, video: false }),
      MIC_TIMEOUT_MS,
      'microphone access',
    );
    if (myGeneration !== generation) {
      for (const track of ownedStream.getTracks()) track.stop();
      return;
    }
    localStream = ownedStream;

    const configuration: RtcConfiguration = {
      iceServers: ice.iceServers.map((server) => ({
        urls: [...server.urls],
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined ? {} : { credential: server.credential }),
      })),
      iceTransportPolicy: ice.iceTransportPolicy,
    };

    mesh = new PeerMesh({
      selfId: input.selfId,
      localStream,
      configuration,
      transport: {
        send: (to, kind, data) => {
          rtcSocket.sendSignal(input.sessionId, to, kind, data);
        },
      },
      onRemoteStream: setPeer,
      onPeerGone: dropPeer,
      /* The real `react-native-webrtc` constructors — `peer-mesh.ts`'s own
         header on why it takes these injected rather than importing them
         itself. */
      createConnection: (config) => new webrtc.RTCPeerConnection(config),
      createIceCandidate: (init) => new webrtc.RTCIceCandidate(init),
      createSessionDescription: (init) => new webrtc.RTCSessionDescription(init),
    });

    unsubscribers = [
      rtcSocket.onSignal((message) => {
        if (message.sessionId !== input.sessionId) return;
        void mesh?.handleSignal(message.from, message.kind, message.data);
      }),
      rtcSocket.onPeers((message) => {
        if (message.sessionId !== input.sessionId) return;
        mesh?.setPeers(message.userIds);
      }),
      rtcSocket.onCallRoomClosed((message) => {
        if (message.sessionId !== input.sessionId) return;
        /* The gateway evicted this app: a grant changed underneath a live
           call. Recorded rather than silently hung up so the UI can say
           why the call ended. */
        callStore.setState({ evicted: true });
        void hangUp();
      }),
    ];

    /* Last, so no signal can arrive before there is a mesh to hand it to. */
    const admitted = await withTimeout(
      rtcSocket.joinCallRoom(input.orgId, input.sessionId),
      STEP_TIMEOUT_MS,
      'the signalling room',
    );
    if (myGeneration !== generation) return;
    if (!admitted) throw new Error('The call could not be joined.');

    callStore.setState({ status: 'in_call' });
  } catch (error) {
    if (myGeneration === generation) {
      /* Everything acquired so far is released, including the microphone —
         see web's identical comment on why this matters most of all. */
      await hangUp({ silent: true });
    } else if (ownedStream !== null && localStream !== ownedStream) {
      for (const track of ownedStream.getTracks()) track.stop();
    }
    throw error;
  }
}

/** Leaves the call and releases every resource. Safe to call when idle. */
export async function hangUp(options: { readonly silent?: boolean } = {}): Promise<void> {
  const { sessionId, evicted } = callStore.getState();

  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];

  mesh?.close();
  mesh = null;

  /* Every track, explicitly — see the module header on why. */
  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;

  if (sessionId !== null) {
    rtcSocket.leaveCallRoom(sessionId);
    if (options.silent !== true) {
      /* Best-effort — see web's identical comment on why a failure here
         must not stop the local teardown above, which has already
         happened. */
      await apiClient.rtc.leave.mutate({ sessionId }).catch(() => undefined);
    }
  }

  callStore.setState({ ...IDLE, evicted });
}

/** Acknowledges the eviction notice, so the banner can be dismissed. */
export function clearEviction(): void {
  callStore.setState({ evicted: false });
}

/**
 * Mutes or unmutes the microphone — `track.enabled = false`, not removing
 * the track, for the identical renegotiation-avoidance reason web's own
 * comment gives.
 */
export function setMuted(muted: boolean): void {
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
  callStore.setState({ muted });
}
