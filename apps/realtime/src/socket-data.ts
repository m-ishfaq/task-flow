import type { Namespace, Server, Socket } from 'socket.io';
import type { OrgId, UserId } from '@taskflow/contracts';
import type {
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ClientToServerEvents,
  ServerToClientEvents,
} from './wire.js';

/**
 * What the server knows about a socket.
 *
 * ⚠ Every field here is SERVER-WRITTEN. Nothing in this interface is ever
 * assigned from a client message, and `identity` in particular is assigned in
 * exactly one place — `gateway.ts`'s `io.use()` middleware, from the verified
 * handshake. That single-assignment property is what §3.7 rests on, and it is
 * why the type is declared here rather than inline: a second place that could
 * write `socket.data.identity` would be invisible in a diff, whereas a second
 * import of this module is not.
 */
export interface SocketData {
  /** From the verified access token, at handshake. Never from a payload. */
  identity: {
    readonly userId: UserId;
    readonly sessionId: string;
  };
  /**
   * Board rooms this socket has been granted, and the org each was granted in.
   *
   * The org is recorded per room rather than per socket because one connection
   * can legitimately hold boards in two organizations — a consultant with two
   * memberships, one browser, two tabs sharing a socket. Storing a single
   * `orgId` on the socket would make `member.removed` in one org silently drop
   * the user's rooms in the other.
   */
  readonly rooms: Map<string, OrgId>;
  /** Remote address as resolved through the configured proxy trust. */
  readonly address: string;
}

/**
 * The fully-typed socket, so handlers get inference on both event maps.
 *
 * The third parameter is server-side events, and it MUST match `GatewayServer`'s
 * — every socket `io.on('connection', ...)` hands back is a
 * `Socket<L, E, InterServerEvents, D>` because that is the `S` the `Server` it
 * came from was built with. Declaring it as `Record<string, never>` here typechecks
 * in isolation but not against a real connection handler, which is exactly the
 * kind of mismatch a type-only module does not catch on its own.
 */
export type GatewaySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type GatewayServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * The `/chat` namespace and its sockets (ai/phase-5-chat.md §3.2).
 *
 * `SocketData` is REUSED rather than copied, and that is worth pausing on. A
 * namespace connection is a distinct `Socket` object with its own `data`, so a
 * chat socket's `rooms` map holds CHANNEL ids while a board socket's holds board
 * ids — the same field name, two disjoint populations, no possibility of one
 * being read as the other because they are never the same object.
 *
 * What is shared is `identity`, and it is shared in the way that matters: the
 * chat namespace runs the SAME `verifyHandshake` middleware, so a chat socket's
 * identity is set once, from the same verified token, and is never assignable
 * from a chat message. §3.2's "this phase adds zero new authentication code" is
 * this line.
 */
export type ChatSocket = Socket<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type ChatNamespace = Namespace<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Events between gateway instances.
 *
 * `revocation` is delivered with `io.serverSideEmit`, which the Postgres adapter
 * carries to every other instance. It matters: the relay claims disjoint batches
 * (`SKIP LOCKED`), so the instance that claims a `session.revoked` event is
 * almost never the instance holding that user's socket. Without this hop, a
 * revocation would take effect only for whoever happened to be connected to the
 * claiming instance — which at one instance is indistinguishable from working
 * correctly, and silently stops being true the first time a second one starts.
 */
export interface InterServerEvents {
  revocation: (message: RevocationMessage) => void;
}

/**
 * A revocation, reduced to what any instance needs to act on it.
 *
 * The outbox row itself is not sent: it carries the full event payload, and
 * these payloads name subjects and objects that no peer instance needs in order
 * to decide "drop this socket". Narrowing here means a broadcast between
 * processes carries the minimum, and that the mapping from event to action lives
 * in one place rather than being re-derived per instance.
 */
export type RevocationMessage =
  | { readonly kind: 'session'; readonly sessionId: string; readonly reason: SessionEndReason }
  | { readonly kind: 'member_removed'; readonly orgId: string; readonly userId: string }
  | { readonly kind: 'recheck_user'; readonly orgId: string; readonly userId: string }
  | { readonly kind: 'recheck_org'; readonly orgId: string };

export type SessionEndReason = 'session_revoked' | 'token_reuse_detected';
