import type {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import type { SignalKind } from './rtc-socket.js';

/**
 * The mesh of peer connections behind one call (ai/phase-13-webrtc.md
 * §3.5), ported from `apps/web/src/features/rtc/peer-mesh.ts`. The
 * negotiation logic is UNCHANGED — glare avoidance, signal handling,
 * teardown ordering — because none of it is browser-specific; what
 * differs is only which module `RTCPeerConnection`/`RTCIceCandidate`/
 * `RTCSessionDescription` come from. See that file's own header for the
 * full reasoning on the offerer tie-break; restated briefly below where
 * this file's own comments would otherwise just repeat it verbatim.
 *
 * ## Every native constructor is injected — none are imported at runtime
 *
 * Web never imports `RTCPeerConnection`/`RTCIceCandidate`/
 * `RTCSessionDescription` at all: they are browser globals. This file
 * genuinely needs to import them from `react-native-webrtc` — but only
 * `import type`, never a value import, because `react-native-webrtc`'s
 * entry point resolves (via this app's `customConditions: ["react-native"]`
 * tsconfig, matching Metro's own resolution) to Flow-typed SOURCE that
 * Vitest's esbuild transform cannot parse at all (`SyntaxError: Unexpected
 * token 'typeof'`, confirmed directly) — the identical wall `secure-
 * store.ts`'s own header already documents for `expo-secure-store`. A type
 * import is erased before any of that runs; a value import is not.
 *
 * The consequence: `createConnection`, `createIceCandidate` and
 * `createSessionDescription` are all REQUIRED options here (unlike web's
 * optional `createConnection`, which has a real browser-global default to
 * fall back to) — `use-call.ts`, the untested native composition point,
 * supplies the real `react-native-webrtc` constructors; `peer-mesh.test.ts`
 * supplies fakes. Neither this file nor its test needs `react-native-
 * webrtc` to actually load.
 *
 * ## Two real API differences from the browser, both handled here
 *
 * ICE candidates and session descriptions are constructed via
 * `createIceCandidate(...)`/`createSessionDescription(...)` here rather
 * than passed as plain objects — the browser's `addIceCandidate`/
 * `setRemoteDescription` accept a bare `RTCIceCandidateInit`/
 * `RTCSessionDescriptionInit` dict directly, and while `react-native-
 * webrtc`'s own type signature is loose enough (`any`) to accept one too,
 * constructing the real class is what the library's own docs and examples
 * do, and is what keeps this file honest about which shape is actually
 * flowing through it.
 *
 * Events are read off the `onicecandidate`/`ontrack`/
 * `onconnectionstatechange` property SETTERS, not `addEventListener` —
 * `RTCPeerConnection`'s own shipped type declarations (`lib/typescript/
 * RTCPeerConnection.d.ts`) import their event-map types from a
 * `./vendor/event-target-shim` path that exists in the package's SOURCE
 * tree but is absent from its compiled `lib/typescript` output (confirmed
 * by inspecting the installed package directly), which breaks
 * `addEventListener`'s typing — `tsc` reports it as simply not existing on
 * the class. The setters are declared directly on `RTCPeerConnection`
 * itself rather than inherited, so they survive that gap; each callback
 * below carries an explicit LOCAL parameter type for exactly the fields
 * read (`RtcIceCandidateEvent`/`RtcTrackEvent`) rather than trusting
 * whatever the library's own (equally affected) type resolves to.
 */

/** The one field this file reads off `RTCPeerConnection`'s `icecandidate` event. */
interface RtcIceCandidateEvent {
  readonly candidate: {
    toJSON: () => { candidate: string; sdpMLineIndex: number | null; sdpMid: string | null };
  } | null;
}

/** The one field this file reads off `RTCPeerConnection`'s `track` event. */
interface RtcTrackEvent {
  readonly streams: readonly MediaStream[];
}

/**
 * The fields this file actually sets — never the DOM lib's own ambient
 * `RTCConfiguration` (this app's `lib` includes `DOM`, per `expo/
 * tsconfig.base`, for unrelated reasons). That type's `certificates` field
 * is typed against DOM's OWN `RTCCertificate` interface, which is a
 * different, incompatible type from `react-native-webrtc`'s own
 * `RTCCertificate` class — a mismatch that only `exactOptionalPropertyTypes`
 * surfaces, and only because the DOM type happens to be structurally close
 * enough otherwise to type-check as `RTCConfiguration` right up until that
 * one field. Nothing here ever sets `certificates`, so a narrower local
 * type sidesteps the whole question rather than fighting two same-named,
 * different types.
 */
export interface RtcConfiguration {
  /* A plain (non-readonly) array, matching `react-native-webrtc`'s own
     local `RTCConfiguration.iceServers: RTCIceServer[]` exactly — this
     type exists only to flow into `createConnection(...)`, so there is no
     later reader for `readonly` to protect. */
  readonly iceServers: {
    urls: string[];
    username?: string;
    credential?: string;
  }[];
  readonly iceTransportPolicy: 'all' | 'relay';
}

/** The one shape `createIceCandidate`/`RTCIceCandidate`'s own constructor takes. */
export interface RtcIceCandidateInit {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

/** The one shape `createSessionDescription`/`RTCSessionDescription`'s own constructor takes. */
export interface RtcSessionDescriptionInit {
  readonly sdp: string;
  readonly type: string | null;
}

export interface PeerTransport {
  /** Sends one signalling message. Fire-and-forget; see `rtc-socket.ts`. */
  send: (to: string, kind: SignalKind, data: string) => void;
}

export interface PeerMeshOptions {
  /** This tab's own user id. Half of the offer tie-break. */
  readonly selfId: string;
  /** The microphone. Tracks are added to every peer connection. */
  readonly localStream: MediaStream;
  readonly configuration: RtcConfiguration;
  readonly transport: PeerTransport;
  readonly onRemoteStream: (userId: string, stream: MediaStream) => void;
  readonly onPeerGone: (userId: string) => void;
  /** Test/native seam — see the module header on why all three are required. */
  readonly createConnection: (configuration: RtcConfiguration) => RTCPeerConnection;
  readonly createIceCandidate: (init: RtcIceCandidateInit) => RTCIceCandidate;
  readonly createSessionDescription: (init: RtcSessionDescriptionInit) => RTCSessionDescription;
}

/** True when `selfId` is the side responsible for making the offer. */
export function isOfferer(selfId: string, peerId: string): boolean {
  return selfId < peerId;
}

export class PeerMesh {
  readonly #options: PeerMeshOptions;
  readonly #peers = new Map<string, RTCPeerConnection>();
  #closed = false;

  constructor(options: PeerMeshOptions) {
    this.#options = options;
  }

  /** Peer ids with a live connection. Exposed for the UI and for tests. */
  get peerIds(): readonly string[] {
    return [...this.#peers.keys()];
  }

  /**
   * Reconciles the mesh against the room roster.
   *
   * Takes the FULL list rather than a delta, because that is what the
   * gateway broadcasts and for the reason it does: one missed delta would
   * leave this app permanently unconnected to one specific person, and the
   * call would work for everyone except that pair.
   */
  setPeers(userIds: readonly string[]): void {
    if (this.#closed) return;

    const wanted = new Set(userIds.filter((userId) => userId !== this.#options.selfId));

    for (const userId of [...this.#peers.keys()]) {
      if (!wanted.has(userId)) this.#drop(userId);
    }

    for (const userId of wanted) {
      if (this.#peers.has(userId)) continue;
      const connection = this.#open(userId);

      /* Only one side offers. The other waits — and must, or both would. */
      if (isOfferer(this.#options.selfId, userId)) {
        void this.#offerTo(userId, connection);
      }
    }
  }

  /**
   * Applies one signal from a peer.
   *
   * `from` comes off the wire message, where the GATEWAY stamped it from
   * the sender's handshake identity — a client cannot name its own `from`
   * (ai/phase-13-webrtc.md §3.2). That is what makes it safe to use as the
   * key into the peer map here.
   */
  async handleSignal(from: string, kind: SignalKind, data: string): Promise<void> {
    if (this.#closed || from === this.#options.selfId) return;

    /* A signal can legitimately arrive before the roster broadcast that
       would have created the connection — the offerer sends as soon as IT
       sees us. Creating the connection on demand is what stops the first
       call between two people from depending on message ordering. */
    const connection = this.#peers.get(from) ?? this.#open(from);

    if (kind === 'candidate') {
      /* A candidate for a connection with no remote description yet is
         refused rather than queued. Swallowed rather than surfaced: ICE is
         additive and the peer will send more. */
      try {
        const init = JSON.parse(data) as RtcIceCandidateInit;
        await connection.addIceCandidate(this.#options.createIceCandidate(init));
      } catch {
        /* Intentionally ignored — see above. */
      }
      return;
    }

    const init = JSON.parse(data) as RtcSessionDescriptionInit;
    await connection.setRemoteDescription(this.#options.createSessionDescription(init));

    if (kind === 'offer') {
      /* `createAnswer()` is typed `Promise<any>` by `react-native-webrtc`
         itself (its own `RTCPeerConnection.d.ts`) — an explicit local type
         here is what keeps `answer` from carrying that `any` into
         `setLocalDescription`/`JSON.stringify` below. */
      const answer = (await connection.createAnswer()) as RtcSessionDescriptionInit;
      await connection.setLocalDescription(answer);
      this.#options.transport.send(from, 'answer', JSON.stringify(answer));
    }
  }

  /** Tears every connection down. Safe to call twice. */
  close(): void {
    this.#closed = true;
    for (const userId of [...this.#peers.keys()]) this.#drop(userId);
  }

  #open(userId: string): RTCPeerConnection {
    const connection = this.#options.createConnection(this.#options.configuration);

    for (const track of this.#options.localStream.getTracks()) {
      connection.addTrack(track, this.#options.localStream);
    }

    connection.onicecandidate = (event: RtcIceCandidateEvent) => {
      /* A null candidate is "gathering finished", not a candidate. Sending
         it would be a signal the far side has to special-case for no
         reason. */
      if (event.candidate === null) return;
      this.#options.transport.send(userId, 'candidate', JSON.stringify(event.candidate.toJSON()));
    };

    connection.ontrack = (event: RtcTrackEvent) => {
      const stream = event.streams[0];
      if (stream !== undefined) this.#options.onRemoteStream(userId, stream);
    };

    /* Cleared to `null` by `#drop` BEFORE calling `close()` — see that
       method's own comment on why. */
    connection.onconnectionstatechange = () => {
      /* `failed` is terminal — ICE has exhausted every candidate pair.
         `closed` is us. Neither is recoverable by waiting, and both mean
         the UI should stop showing this person as connected.
         `disconnected` is deliberately NOT here: it is frequently
         transient (a network handover) and recovers on its own, so
         tearing down on it would drop calls that were about to come
         back. */
      const state = connection.connectionState;
      if (state === 'failed' || state === 'closed') this.#options.onPeerGone(userId);
    };

    this.#peers.set(userId, connection);
    return connection;
  }

  async #offerTo(userId: string, connection: RTCPeerConnection): Promise<void> {
    /* Same `Promise<any>` reason as `createAnswer()` above. */
    const offer = (await connection.createOffer()) as RtcSessionDescriptionInit;

    /* Re-checked AFTER the await. `createOffer` is asynchronous, so a user
       who hangs up in that window would otherwise have an offer sent on
       their behalf to a peer they are no longer in a call with — the far
       side then opens a connection to a tab that has already stopped
       listening and waits out the ICE timeout showing them as connecting. */
    if (this.#closed || !this.#peers.has(userId)) return;

    await connection.setLocalDescription(offer);
    this.#options.transport.send(userId, 'offer', JSON.stringify(offer));
  }

  #drop(userId: string): void {
    const connection = this.#peers.get(userId);
    if (connection === undefined) return;

    /* `onconnectionstatechange` cleared BEFORE close(). `close()` fires it
       with `closed`, which would call `onPeerGone` for a peer the caller
       has already forgotten — and in the `setPeers` path, re-entrantly,
       while we are iterating the map. `onicecandidate`/`ontrack` need no
       equivalent clearing: a closed connection does not go on producing
       ICE candidates or tracks. */
    connection.onconnectionstatechange = null;
    connection.close();

    this.#peers.delete(userId);
    this.#options.onPeerGone(userId);
  }
}
