import { z } from 'zod';
import {
  BoardIdSchema,
  ChannelIdSchema,
  OrgIdSchema,
  type BoardId,
  type ChannelId,
  type OrgId,
} from '@taskflow/contracts';

/**
 * The socket wire contract (ai/phase-4-realtime.md §3.6, §3.7, §6.3).
 *
 * Exported from this app's `./events` entry point so `apps/web` compiles
 * against the SAME declarations the gateway serves — the socket equivalent of
 * what tRPC's generated client does for HTTP. Two hand-maintained copies of a
 * message shape drift, and the drift shows up as a broadcast the client
 * silently ignores.
 *
 * ## Two things this file is careful about
 *
 * **There is nowhere to assert an identity.** `JoinRequest` carries a board id
 * and nothing else. That is not an omission to be filled in later: §3.7 is that
 * a socket's identity is decided once, at the handshake, from a verified token,
 * and every handler reads it from `socket.data`. A `userId` field here would be
 * a value in JSON indistinguishable from any other value an attacker chose to
 * write, and the shape of the most damaging Socket.io vulnerability there is.
 * Adding one to this interface IS the vulnerability, not a step toward it.
 *
 * **Dates are strings.** Every payload here crosses a JSON boundary, so
 * `occurredAt` arrives as the string `JSON.stringify` produced — exactly the
 * problem `apps/web/src/lib/wire.ts` exists for on the tRPC side. It is typed
 * as `string` rather than `Date` so the compiler stops agreeing with a lie
 * nothing at runtime supports.
 */

/* -------------------------------------------------------------------------- *
 * Client -> server
 * -------------------------------------------------------------------------- */

/**
 * "Let me into this board's room."
 *
 * Both fields are client-supplied, and both are safe for the same reason — but
 * the reason is worth stating precisely, because it is exactly the distinction
 * §3.7 turns on.
 *
 * `boardId` is a REQUEST, the same way a browser naming a URL is a request.
 * `can()` decides whether to grant it; the client was never trusted to ask only
 * for boards it can see.
 *
 * `orgId` is a SCOPE SELECTOR, and it is the socket's equivalent of the
 * `x-taskflow-org` header — which CLAUDE.md's Phase 2 notes describe as
 * attacker-controlled and treated as such. It is used identically here: never
 * written to `app.org_id`, never turned into a role, only a WHERE filter inside
 * `withUserScope(verifiedUserId)`. Naming an org you are not in matches zero
 * membership rows and the join is refused.
 *
 * What is NOT here, and must never be, is a subject. Neither field says who the
 * caller is; that was decided at the handshake and lives on `socket.data`.
 *
 * `.strict()` so an extra field is a rejection rather than something quietly
 * ignored. A client sending `{ orgId, boardId, userId }` gets an error, which is
 * a far better outcome than the field being dropped silently and someone later
 * "fixing" the handler to read it.
 */
export interface JoinRequest {
  readonly orgId: OrgId;
  readonly boardId: BoardId;
}

/**
 * Annotated with its own output type rather than left to infer.
 *
 * A branded id's tag (`ids.ts`'s `declare const brand: unique symbol`) is
 * intentionally unexported — naming a type is not the same as being able to
 * mint one. `tsc`'s declaration emit (`base.json`'s `declaration: true`) has to
 * print SOME type for this exported binding, though, and Zod's own inferred
 * type for a schema this shape is a large structural expansion that goes
 * looking for a name for that symbol and fails with TS4023. The explicit
 * `z.ZodType<JoinRequest>` gives it an already-nameable type to check against
 * instead of one to derive, the same fix `packages/filter/src/ast.ts` and
 * `work/richtext.ts` use for their own recursive schemas.
 */
export const JoinRequestSchema: z.ZodType<
  JoinRequest,
  z.ZodTypeDef,
  { orgId: string; boardId: string }
> = z.object({ orgId: OrgIdSchema, boardId: BoardIdSchema }).strict();

export interface LeaveRequest {
  readonly boardId: BoardId;
}

export const LeaveRequestSchema: z.ZodType<LeaveRequest, z.ZodTypeDef, { boardId: string }> = z
  .object({ boardId: BoardIdSchema })
  .strict();

/**
 * Why a join was refused.
 *
 * Deliberately coarse. `denied` covers "no such board", "board in another
 * tenant", and "you are not permitted" identically, for the same reason
 * `enforce()` answers 404 rather than 403 for an invisible resource: a refusal
 * that distinguishes them lets someone enumerate which board ids exist by
 * reading the reason string.
 */
export type JoinRefusal = 'denied' | 'invalid' | 'rate_limited';

export type JoinAck = { readonly ok: true } | { readonly ok: false; readonly reason: JoinRefusal };

/* -------------------------------------------------------------------------- *
 * Server -> client
 * -------------------------------------------------------------------------- */

/**
 * What the gateway tells a client once its handshake succeeded.
 *
 * `reauthLeadSeconds` is served rather than hardcoded in the browser (§7.1).
 * Today it comes from the gateway's environment; when a platform-settings
 * surface exists (§7.6) it comes from there, and the client does not change.
 * A constant in `apps/web` would be a second place for the number to live and
 * the one nobody remembers to update.
 */
export interface ReadyMessage {
  readonly reauthLeadSeconds: number;
}

/**
 * One broadcast domain event.
 *
 * `mutationId` is the originating request's id, carried through from
 * `envelopeOf(actor)` in the API rather than minted here — §3.6. A client that
 * just performed a mutation optimistically already has this state, so it drops
 * the echo instead of re-applying it and flickering. Null when the event had no
 * request behind it (a scheduled job, a system action), which is a real value
 * and not a missing one.
 *
 * `version` is the EVENT SCHEMA's version, from the outbox row. A client seeing
 * a version it does not know refetches rather than parsing a payload whose shape
 * it is guessing at.
 */
export interface BroadcastMessage {
  readonly name: string;
  readonly version: number;
  readonly orgId: string;
  /** The room this was delivered on — `board:{boardId}`'s subject. */
  readonly boardId: string;
  readonly actorId: string | null;
  readonly mutationId: string | null;
  /** ISO 8601. A string on the wire; see the note at the top of this file. */
  readonly occurredAt: string;
  readonly payload: unknown;
}

/**
 * The gateway removed this socket from a room it had joined (§7.2).
 *
 * Sent when a membership or grant changed underneath a long-lived connection —
 * the case §3.3 exists for, where a join decision made an hour ago is no longer
 * true. The client drops its live state for that board and falls back to
 * ordinary polled queries; it does not retry the join, because the answer will
 * not have changed.
 */
export interface RoomClosedMessage {
  readonly boardId: string;
}

/**
 * The credential itself is gone — a revoked session, or refresh-token reuse
 * detected (§7.2). The connection closes immediately after this is sent.
 *
 * Distinct from `room:closed` because the client's response is different: there
 * is no board to fall back to polling on, and reconnecting with the same token
 * would fail. The web client treats this the way an expired session is treated
 * everywhere else — it stops, rather than retrying into a loop.
 */
export interface SessionEndedMessage {
  readonly reason: 'session_revoked' | 'token_reuse_detected';
}

/**
 * Who currently has this board's room open (§9, Wave 2).
 *
 * `userIds` is the full current membership, not a delta — the same reasoning
 * `card.assigned`'s `before`/`after` sets give: a client rendering an avatar
 * stack needs "who is here now," and reconstructing that from a stream of
 * joined/left deltas means every client must never miss one or its stack
 * silently drifts from reality. Deduplicated: one person with two tabs open
 * on the same board appears once.
 *
 * In-process and ephemeral (§9) — computed from the gateway's own room
 * membership at the moment of the change, never persisted, never the audit
 * log's business. It is not a domain event and does not go through the
 * outbox: nothing here is a fact about the ORG's data, only about who is
 * currently looking at it, which stops being true the instant a tab closes.
 */
export interface PresenceMessage {
  readonly boardId: string;
  readonly userIds: readonly string[];
}

/** Server-to-client events, named for `io.on`/`socket.on` type inference. */
export interface ServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  broadcast: (message: BroadcastMessage) => void;
  'room:closed': (message: RoomClosedMessage) => void;
  'session:ended': (message: SessionEndedMessage) => void;
  presence: (message: PresenceMessage) => void;
}

/** Client-to-server events. Note that neither carries an identity — see above. */
export interface ClientToServerEvents {
  'board:join': (request: JoinRequest, ack: (result: JoinAck) => void) => void;
  'board:leave': (request: LeaveRequest) => void;
}

/** The Socket.io room name for a board. One definition, used on both sides. */
export function boardRoom(boardId: string): string {
  return `board:${boardId}`;
}

/** The inverse of `boardRoom`, or null if the room is not a board room. */
export function boardIdOfRoom(room: string): string | null {
  return room.startsWith('board:') ? room.slice('board:'.length) : null;
}

/* -------------------------------------------------------------------------- *
 * Chat (ai/phase-5-chat.md §3.1, §3.2)
 *
 * Chat lives on its own Socket.io NAMESPACE (`/chat`) on this same process, and
 * therefore gets its own event maps rather than extending the two above. That is
 * a deliberate choice with a specific failure in mind: `BroadcastMessage` names
 * the room it was delivered on, and widening it to `boardId | channelId` would
 * make every existing consumer in `apps/web` accept a message it has no handler
 * for, silently, with the compiler agreeing. Two maps mean a chat broadcast
 * cannot be delivered to a board listener even by mistake.
 *
 * Everything ELSE is shared: the same handshake, the same `verifyHandshake`, the
 * same origin check, the same `socket.data.identity`. §3.2 is explicit that this
 * phase adds zero new authentication code.
 * -------------------------------------------------------------------------- */

/**
 * "Let me into this channel's room."
 *
 * The same two fields as `JoinRequest` and the same reasoning applies to both —
 * `channelId` is a REQUEST that `can()` adjudicates, `orgId` is a scope selector
 * used only as a WHERE filter inside `withUserScope(verifiedUserId)`.
 *
 * And the same thing is absent: there is no subject. A DM is the most private
 * surface in this product, so if a `userId` field were ever going to be added to
 * a join request "for convenience", this is the one where it would do the most
 * damage — "subscribe me to this conversation as this person" is the entire
 * vulnerability in a single JSON field. `.strict()` refuses it rather than
 * ignoring it, because a silently dropped field invites a handler that reads it.
 */
export interface ChannelJoinRequest {
  readonly orgId: OrgId;
  readonly channelId: ChannelId;
}

/** Annotated rather than inferred — see the note on `JoinRequestSchema`. */
export const ChannelJoinRequestSchema: z.ZodType<
  ChannelJoinRequest,
  z.ZodTypeDef,
  { orgId: string; channelId: string }
> = z.object({ orgId: OrgIdSchema, channelId: ChannelIdSchema }).strict();

export interface ChannelLeaveRequest {
  readonly channelId: ChannelId;
}

export const ChannelLeaveRequestSchema: z.ZodType<
  ChannelLeaveRequest,
  z.ZodTypeDef,
  { channelId: string }
> = z.object({ channelId: ChannelIdSchema }).strict();

/**
 * "I am typing in this channel" / "I stopped."
 *
 * Never a domain event (`apps/api/src/chat/events.ts`'s header names this
 * exact exclusion) — there is no persisted state for guardrail 11 to require
 * an event for, so it is relayed in-process on the already-joined room and
 * dies with the connection. The same no-identity rule as `ChannelJoinRequest`
 * applies for the same reason: this carries only the channel, never a userId,
 * because the gateway already knows who sent it from `socket.data.identity`.
 */
export interface TypingRequest {
  readonly channelId: ChannelId;
}

export const TypingRequestSchema: z.ZodType<TypingRequest, z.ZodTypeDef, { channelId: string }> =
  z.object({ channelId: ChannelIdSchema }).strict();

/**
 * Relayed to everyone else in the room. `userId` is filled in by the gateway
 * from the sender's own `socket.data.identity`, never from the client's
 * request — the same reason a join request carries no subject. `typing`
 * distinguishes a start from a stop on the one event name, rather than two
 * message shapes a listener would need to tell apart by which handler fired.
 */
export interface TypingMessage {
  readonly channelId: string;
  readonly userId: string;
  readonly typing: boolean;
}

/**
 * One broadcast chat event.
 *
 * Structurally the board version with `channelId` in place of `boardId`, and
 * kept as its own type for the reason given at the top of this section.
 *
 * `payload` is the domain event's payload verbatim — `message.sent` carries an
 * excerpt and the mentioned user ids, never the full document, and never a
 * presigned URL. The attachment exclusion Phase 4 §4 enforces applies here
 * unchanged: a file message broadcasts an `attachmentId`, and the client asks
 * for a URL over authorized HTTP.
 */
export interface ChatBroadcastMessage {
  readonly name: string;
  readonly version: number;
  readonly orgId: string;
  /** The room this was delivered on — `channel:{channelId}`'s subject. */
  readonly channelId: string;
  readonly actorId: string | null;
  readonly mutationId: string | null;
  /** ISO 8601. A string on the wire; see the note at the top of this file. */
  readonly occurredAt: string;
  readonly payload: unknown;
}

/** The gateway removed this socket from a channel room it had joined. */
export interface ChannelClosedMessage {
  readonly channelId: string;
}

export interface ChatServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  broadcast: (message: ChatBroadcastMessage) => void;
  'channel:closed': (message: ChannelClosedMessage) => void;
  'session:ended': (message: SessionEndedMessage) => void;
  typing: (message: TypingMessage) => void;
}

export interface ChatClientToServerEvents {
  'channel:join': (request: ChannelJoinRequest, ack: (result: JoinAck) => void) => void;
  'channel:leave': (request: ChannelLeaveRequest) => void;
  'typing:start': (request: TypingRequest) => void;
  'typing:stop': (request: TypingRequest) => void;
}

/** The Socket.io room name for a channel. One definition, used on both sides. */
export function channelRoom(channelId: string): string {
  return `channel:${channelId}`;
}

/** The inverse of `channelRoom`, or null if the room is not a channel room. */
export function channelIdOfRoom(room: string): string | null {
  return room.startsWith('channel:') ? room.slice('channel:'.length) : null;
}

/** The namespace chat is served on. One definition, used by both sides. */
export const CHAT_NAMESPACE = '/chat';
