import type { SignalKind } from '../../lib/rtc-socket.js';

/**
 * The mesh of peer connections behind one call (ai/phase-13-webrtc.md §3.5).
 *
 * ## Who offers, and why it is decided by comparing two strings
 *
 * The classic WebRTC bug in a mesh is GLARE: both peers send an offer at the
 * same moment, both are in `have-local-offer`, and both reject the other's —
 * so the connection never forms. The audio simply never arrives, with no error
 * anywhere, and it reproduces only when two people join within the same few
 * hundred milliseconds, which is to say when it matters.
 *
 * The usual fix is "perfect negotiation": a polite peer that rolls back its own
 * offer. It is correct and it is a lot of state. This does something much
 * smaller that is sufficient for a mesh where every pair is symmetric: for any
 * two participants, **the lexicographically smaller user id makes the offer**.
 * Every pair has exactly one smaller id, so exactly one side offers and glare
 * cannot occur — no rollback, no `makingOffer` flag, no `ignoreOffer` branch.
 *
 * The trade, stated because it stops being free later: this cannot handle a
 * RENEGOTIATION initiated by the larger id (adding a video track in Wave 3 from
 * the "wrong" side). At that point perfect negotiation is the answer, and this
 * comment is the thing to come back and delete.
 *
 * ## The connection factory is injected
 *
 * `RTCPeerConnection` does not exist in a Node test environment, and building
 * this against a real browser would make the negotiation rules — the part that
 * is actually easy to get wrong — untestable. The seam is a one-line default so
 * no production path can get a different implementation.
 */

export interface PeerTransport {
  /** Sends one signalling message. Fire-and-forget; see `rtc-socket.ts`. */
  send: (to: string, kind: SignalKind, data: string) => void;
}

export interface PeerMeshOptions {
  /** This tab's own user id. Half of the offer tie-break. */
  readonly selfId: string;
  /** The microphone. Tracks are added to every peer connection. */
  readonly localStream: MediaStream;
  readonly configuration: RTCConfiguration;
  readonly transport: PeerTransport;
  readonly onRemoteStream: (userId: string, stream: MediaStream) => void;
  readonly onPeerGone: (userId: string) => void;
  /** Test seam — see the header. */
  readonly createConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
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
   * Takes the FULL list rather than a delta, because that is what the gateway
   * broadcasts and for the reason it does: one missed delta would leave this tab
   * permanently unconnected to one specific person, and the call would work for
   * everyone except that pair.
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
   * `from` comes off the wire message, where the GATEWAY stamped it from the
   * sender's handshake identity — a client cannot name its own `from`
   * (ai/phase-13-webrtc.md §3.2). That is what makes it safe to use as the key
   * into the peer map here.
   */
  async handleSignal(from: string, kind: SignalKind, data: string): Promise<void> {
    if (this.#closed || from === this.#options.selfId) return;

    /* A signal can legitimately arrive before the roster broadcast that would
       have created the connection — the offerer sends as soon as IT sees us.
       Creating the connection on demand is what stops the first call between
       two people from depending on message ordering. */
    const connection = this.#peers.get(from) ?? this.#open(from);

    if (kind === 'candidate') {
      /* A candidate for a connection with no remote description yet is dropped
         by the browser with an exception rather than queued. Swallowed rather
         than surfaced: ICE is additive and the peer will send more. */
      try {
        await connection.addIceCandidate(JSON.parse(data) as RTCIceCandidateInit);
      } catch {
        /* Intentionally ignored — see above. */
      }
      return;
    }

    const description = JSON.parse(data) as RTCSessionDescriptionInit;
    await connection.setRemoteDescription(description);

    if (kind === 'offer') {
      const answer = await connection.createAnswer();
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
    const create =
      this.#options.createConnection ??
      ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));

    const connection = create(this.#options.configuration);

    for (const track of this.#options.localStream.getTracks()) {
      connection.addTrack(track, this.#options.localStream);
    }

    connection.onicecandidate = (event) => {
      /* A null candidate is "gathering finished", not a candidate. Sending it
         would be a signal the far side has to special-case for no reason. */
      if (event.candidate === null) return;
      this.#options.transport.send(userId, 'candidate', JSON.stringify(event.candidate.toJSON()));
    };

    connection.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream !== undefined) this.#options.onRemoteStream(userId, stream);
    };

    connection.onconnectionstatechange = () => {
      /* `failed` is terminal — ICE has exhausted every candidate pair. `closed`
         is us. Neither is recoverable by waiting, and both mean the UI should
         stop showing this person as connected. `disconnected` is deliberately
         NOT here: it is frequently transient (a Wi-Fi handover) and recovers on
         its own, so tearing down on it would drop calls that were about to
         come back. */
      const state = connection.connectionState;
      if (state === 'failed' || state === 'closed') this.#options.onPeerGone(userId);
    };

    this.#peers.set(userId, connection);
    return connection;
  }

  async #offerTo(userId: string, connection: RTCPeerConnection): Promise<void> {
    const offer = await connection.createOffer();

    /* Re-checked AFTER the await. `createOffer` is asynchronous, so a user who
       hangs up in that window would otherwise have an offer sent on their
       behalf to a peer they are no longer in a call with — the far side then
       opens a connection to a tab that has already stopped listening and waits
       out the ICE timeout showing them as connecting. */
    if (this.#closed || !this.#peers.has(userId)) return;

    await connection.setLocalDescription(offer);
    this.#options.transport.send(userId, 'offer', JSON.stringify(offer));
  }

  #drop(userId: string): void {
    const connection = this.#peers.get(userId);
    if (connection === undefined) return;

    /* Handlers cleared BEFORE close(). `close()` fires
       `onconnectionstatechange` with `closed`, which would call `onPeerGone`
       for a peer the caller has already forgotten — and in the `setPeers`
       path, re-entrantly, while we are iterating the map. */
    connection.onicecandidate = null;
    connection.ontrack = null;
    connection.onconnectionstatechange = null;
    connection.close();

    this.#peers.delete(userId);
    this.#options.onPeerGone(userId);
  }
}
