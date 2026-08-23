import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { MediaStream } from 'react-native-webrtc';
import type InCallManagerInstance from 'react-native-incall-manager';
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
 *
 * ## `react-native-incall-manager` is what makes the audio audible at all
 *
 * Found live: a real web-to-mobile call negotiated successfully — peers
 * connected, `onRemoteStream` fired, `connectedAt` was set — and was still
 * silent. `react-native-webrtc` has no audio-ROUTING API of its own (its
 * own `src/` has no `speaker`/`audioOutput` export at all); the native
 * `AudioDeviceModule` it hands the OS decides where a call-mode audio
 * stream goes, and on Android that default is the EARPIECE, at a volume
 * meant for a phone held to your face — inaudible to someone looking at
 * this app's own on-screen mute/hang-up controls instead. Silent, not
 * broken: nothing here was wrong, there was just no audio ROUTE, the exact
 * gap `react-native-incall-manager` exists to close (same maintainer org as
 * `react-native-webrtc` — the identical "lower-risk than hand-rolling
 * native audio-manager code" reasoning `@config-plugins/react-native-webrtc`
 * was chosen for earlier in this phase). `start()` puts Android into
 * `MODE_IN_COMMUNICATION` for the call's duration. `stop()` on `hangUp()`
 * hands audio routing back to whatever else wants it (the ringtone/ringback
 * tones already use `expo-audio`, and never overlap this: ringing stops
 * before a call is joined, `InCallManager` starts only once it is).
 * Best-effort — a build without the native module linked yet must still let
 * the call itself proceed, only without the routing fix.
 *
 * ## `setForceSpeakerphoneOn(false)` is not "not speaker" — found live, a
 * second time, against a real Bluetooth headset
 *
 * The first fix above shipped `setForceSpeakerphoneOn(speakerOn)` called
 * unconditionally at join, `speakerOn` defaulting `true`. That is a real bug
 * once a Bluetooth headset is in the picture, confirmed live: the library's
 * own README states `setForceSpeakerphoneOn`'s three states plainly —
 * `true` forces speaker, `false` forces EARPIECE, and only `null` means "use
 * default behaviour according to media type," which is the ONE state that
 * lets its documented automatic device-aware routing (Bluetooth or wired,
 * preferred over speaker or earpiece) actually run. Forcing `true`
 * unconditionally at join overrides an already-connected Bluetooth device
 * before the call even starts; forcing `false` from the on-screen toggle —
 * the previous code's idea of "turn speaker off" — routes to the EARPIECE,
 * not to Bluetooth, which is why tapping it looked like it did nothing: audio
 * stayed on the phone either way.
 *
 * So `speakerOn` in this store means "explicitly forced to speaker," not
 * "speaker vs. everything else" — `setSpeakerphone(true)` still forces
 * speaker; `setSpeakerphone(false)` passes `null`, handing the decision back
 * to automatic routing rather than forcing the earpiece. At join,
 * `getIsWiredHeadsetPluggedIn()` is checked first: a wired headset already
 * connected skips the force-speaker default entirely (there is no
 * equivalent query for Bluetooth in this library's JS surface — see
 * `chooseAudioRoute` below for the real fix if that gap matters enough to
 * close). A Bluetooth headset connected AFTER join is unaffected by any of
 * this and is exactly what tapping the toggle once now correctly reaches.
 *
 * **Not yet done, and worth naming rather than pretending this is
 * complete**: `InCallManager.chooseAudioRoute(route: string)` is the
 * library's real answer to "let the user pick a specific device" (Speaker /
 * Earpiece / a named Bluetooth device / Wired) rather than the two-state
 * force/auto toggle here — building that needs the platform-specific route
 * names enumerated first, which is real, separate work, not a one-line
 * change alongside this fix.
 */

/**
 * `react-native-incall-manager`'s own shipped `.d.ts` types
 * `setForceSpeakerphoneOn` as `(flag: boolean) => void`, but its README
 * documents a real third state this codebase depends on: `null` means "use
 * default behaviour according to media type" — the one value that lets its
 * automatic, Bluetooth-aware routing run instead of forcing a destination.
 * A value cast (`null as boolean`) would lie about what crosses the
 * boundary; this instead corrects the ONE signature that is wrong, in one
 * place, rather than suppressing type-checking on every call site.
 */
function setForceSpeakerphoneOn(manager: typeof InCallManagerInstance, flag: boolean | null): void {
  (manager.setForceSpeakerphoneOn as (flag: boolean | null) => void)(flag);
}

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
  /**
   * Loudspeaker vs earpiece — see the module header on why this defaults to
   * `true` and why it exists at all. Mirrors `muted`: real state a control
   * reads and writes, not a derived value.
   */
  readonly speakerOn: boolean;
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
  speakerOn: true,
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
/** Set only once `react-native-incall-manager` actually started this call's
 *  audio routing — see the module header. `null` both before a call starts
 *  and whenever the native module failed to load, so `hangUp` knows whether
 *  there is anything to stop. */
let inCallManager: typeof InCallManagerInstance | null = null;

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

    /* Best-effort — see the module header. A build without this native
       module linked yet must still let the call proceed, silently, rather
       than fail the whole join over an audio-routing improvement. */
    try {
      const InCallManager = (await import('react-native-incall-manager')).default;
      InCallManager.start({ media: 'audio' });
      /* A wired headset already connected at join time skips the
         force-speaker default entirely — see the module header on why
         `false`/forced-earpiece is never the right choice here, and why
         there is no equivalent check for Bluetooth. A failed check is
         treated as "not plugged in", the same default-to-loud bias the
         unconditional force used before this fix. */
      const wired = await InCallManager.getIsWiredHeadsetPluggedIn().catch(() => ({
        isWiredHeadsetPluggedIn: false,
      }));
      const forceSpeaker = !wired.isWiredHeadsetPluggedIn;
      setForceSpeakerphoneOn(InCallManager, forceSpeaker ? true : null);
      callStore.setState({ speakerOn: forceSpeaker });
      inCallManager = InCallManager;
    } catch {
      inCallManager = null;
    }

    /* TEMPORARY diagnostic — never logs credentials, only the URLs
       themselves. Added to settle, directly rather than by inference from
       coturn's own logs, whether mobile is even being handed a STUN/TURN
       URL it can reach at all (a stale IP or a `localhost` left over from
       the RTC_STUN_URLS/RTC_TURN_URLS bug this file's README already
       documents would look exactly like "coturn is unreachable" from every
       other angle this has been diagnosed from so far). Remove once
       answered. */
    console.warn(
      `[rtc] ice servers: ${JSON.stringify(ice.iceServers.map((server) => server.urls))}`,
    );

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

  /* Hands audio routing back — see the module header on why this is never
     skipped even on a `silent` teardown (a failed join still engaged
     `MODE_IN_COMMUNICATION` the moment the microphone opened). */
  inCallManager?.stop();
  inCallManager = null;

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

/**
 * Toggles FORCED speaker vs automatic device-aware routing — see the
 * module header on why `false` here passes `null` to the native call, not
 * `false`. `setForceSpeakerphoneOn(false)` forces the EARPIECE, which is
 * never what turning this toggle "off" means: the intent is always "let a
 * connected Bluetooth or wired device win, or fall back to the earpiece if
 * there isn't one" — `null` is the one value that hands that decision to
 * the library's own automatic routing instead of forcing a second, wrong
 * destination. A no-op on a build without the native module linked
 * (`inCallManager` stays `null`); the stored `speakerOn` still updates so
 * the button reflects what was asked for.
 */
export function setSpeakerphone(speakerOn: boolean): void {
  if (inCallManager !== null) setForceSpeakerphoneOn(inCallManager, speakerOn ? true : null);
  callStore.setState({ speakerOn });
}
