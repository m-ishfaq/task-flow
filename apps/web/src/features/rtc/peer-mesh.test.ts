import { describe, expect, it, vi } from 'vitest';
import { isOfferer, PeerMesh } from './peer-mesh.js';

/**
 * The negotiation rules, which are the part that is easy to get wrong and
 * impossible to see (ai/phase-13-webrtc.md §3.5).
 *
 * A mesh that glares does not throw. Both peers sit in `have-local-offer`, the
 * audio never arrives, and it reproduces only when two people join within a few
 * hundred milliseconds of each other — so it looks like a flaky network and gets
 * "fixed" by asking the user to try again.
 *
 * `RTCPeerConnection` does not exist here, which is exactly why `createConnection`
 * is a seam: the rules under test are about WHO offers and WHAT is sent, not
 * about the browser's SDP machinery.
 */

class FakeConnection {
  readonly added: MediaStreamTrack[] = [];
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;

  addTrack(track: MediaStreamTrack): void {
    this.added.push(track);
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'fake-offer' });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'answer', sdp: 'fake-answer' });
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
    this.onconnectionstatechange?.();
  }
}

const LOW = 'aaaaaaaa-0000-0000-0000-000000000001';
const HIGH = 'zzzzzzzz-0000-0000-0000-000000000002';

function build(selfId: string) {
  const connections = new Map<number, FakeConnection>();
  let index = 0;

  const sent: { to: string; kind: string; data: string }[] = [];
  const gone: string[] = [];
  const streams: { userId: string; stream: MediaStream }[] = [];

  const mesh = new PeerMesh({
    selfId,
    localStream: { getTracks: () => [{ kind: 'audio' } as MediaStreamTrack] } as MediaStream,
    configuration: {},
    transport: {
      send: (to, kind, data) => {
        sent.push({ to, kind, data });
      },
    },
    onRemoteStream: (userId, stream) => {
      streams.push({ userId, stream });
    },
    onPeerGone: (userId) => {
      gone.push(userId);
    },
    createConnection: () => {
      const connection = new FakeConnection();
      index += 1;
      connections.set(index, connection);
      return connection as unknown as RTCPeerConnection;
    },
  });

  return { mesh, sent, gone, streams, connections };
}

describe('isOfferer', () => {
  it('picks exactly one side of every pair', () => {
    /* THE property. If both sides could answer true, both offer and the
       connection never forms; if both could answer false, neither does and it
       never forms either. Asserted as a pair rather than as two separate
       expectations so the symmetry is what is being checked. */
    expect(isOfferer(LOW, HIGH)).toBe(true);
    expect(isOfferer(HIGH, LOW)).toBe(false);
  });
});

describe('PeerMesh', () => {
  it('offers to a peer with a higher id and stays silent toward a lower one', async () => {
    const low = build(LOW);
    low.mesh.setPeers([LOW, HIGH]);
    await vi.waitFor(() => {
      expect(low.sent).toHaveLength(1);
    });
    expect(low.sent[0]).toMatchObject({ to: HIGH, kind: 'offer' });

    const high = build(HIGH);
    high.mesh.setPeers([HIGH, LOW]);
    /* No offer, ever. The other side is making it — this is the half that
       prevents glare, and it looks exactly like a bug until you read
       `isOfferer`. */
    expect(high.sent).toHaveLength(0);
    expect(high.mesh.peerIds).toEqual([LOW]);
  });

  it('never opens a connection to itself', () => {
    const { mesh } = build(LOW);
    mesh.setPeers([LOW]);
    expect(mesh.peerIds).toEqual([]);
  });

  it('answers an offer and sends the answer back to its sender', async () => {
    const high = build(HIGH);
    /* Deliberately WITHOUT a preceding `setPeers`. A signal can arrive before
       the roster broadcast — the offerer sends as soon as it sees us — and a
       mesh that only accepted signals for known peers would make the first call
       between two people depend on message ordering. */
    await high.mesh.handleSignal(LOW, 'offer', JSON.stringify({ type: 'offer', sdp: 'x' }));

    expect(high.mesh.peerIds).toEqual([LOW]);
    expect(high.sent).toHaveLength(1);
    expect(high.sent[0]).toMatchObject({ to: LOW, kind: 'answer' });
  });

  it('does not answer an answer', async () => {
    const low = build(LOW);
    low.mesh.setPeers([LOW, HIGH]);
    await vi.waitFor(() => {
      expect(low.sent).toHaveLength(1);
    });

    await low.mesh.handleSignal(HIGH, 'answer', JSON.stringify({ type: 'answer', sdp: 'y' }));

    /* Still just the offer. Replying to an answer is an infinite negotiation
       loop between two peers that are already connected. */
    expect(low.sent).toHaveLength(1);
  });

  it('drops a peer that leaves the roster, and reports it once', () => {
    const { mesh, gone } = build(LOW);
    mesh.setPeers([LOW, HIGH]);
    expect(mesh.peerIds).toEqual([HIGH]);

    mesh.setPeers([LOW]);

    expect(mesh.peerIds).toEqual([]);
    /* ONCE. `close()` fires `onconnectionstatechange` with `closed`, so a
       version that did not clear the handler first would report the same
       departure twice — and would do it re-entrantly, while `setPeers` is still
       iterating the map it is mutating. */
    expect(gone).toEqual([HIGH]);
  });

  it('ignores a signal naming itself', async () => {
    const { mesh, sent } = build(LOW);
    await mesh.handleSignal(LOW, 'offer', JSON.stringify({ type: 'offer', sdp: 'x' }));
    expect(mesh.peerIds).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('does not send an offer that was in flight when the caller hung up', async () => {
    const { mesh, sent } = build(LOW);
    mesh.setPeers([LOW, HIGH]);
    /* Synchronously, in the window between `createOffer()` being called and its
       promise resolving — which is exactly where a real hangup lands. */
    mesh.close();

    mesh.setPeers([LOW, HIGH]);
    await mesh.handleSignal(HIGH, 'offer', JSON.stringify({ type: 'offer', sdp: 'x' }));
    await vi.waitFor(() => {
      expect(mesh.peerIds).toEqual([]);
    });

    /* Nothing at all. The first version of this class sent the offer anyway,
       because `#offerTo` only checked `#closed` before awaiting — so the far
       side opened a connection to a tab that had already stopped listening and
       sat out the ICE timeout showing them as "connecting". */
    expect(sent).toHaveLength(0);
  });
});
