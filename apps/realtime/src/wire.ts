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
 * `x-rinavai-org` header — which CLAUDE.md's Phase 2 notes describe as
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

/**
 * "You have a new notification" (Phase 9, ai/phase-9-notifications.md §3.5).
 *
 * Delivered on `user:{userId}` — the one room a socket is placed into by the
 * SERVER at connection time, from `socket.data.identity`, never by a client
 * request (§3.7's rule applied to the one room that needs no `can()` check:
 * nobody needs permission to read their own mailbox). Deliberately minimal —
 * `notificationId` only, no title or excerpt — because the client's only
 * reaction is to invalidate its notification queries (the INVALIDATE
 * strategy §5 already establishes) and refetch over the ordinary authorized
 * tRPC path, the same as every other broadcast strategy here. There is no
 * `userId` field: unlike `BroadcastMessage`'s `boardId` (a ROOM the socket
 * chose to join and must filter events by), this message is only ever
 * delivered to sockets already in the one room it could possibly be for.
 */
export interface NotificationMessage {
  readonly notificationId: string;
}

/**
 * "Someone is calling you" (Phase 13, ai/phase-13-webrtc.md §7).
 *
 * Delivered on `user:{userId}` — the room the SERVER places every socket into
 * at connection time, so this arrives whatever page the person is on, which is
 * the entire point of a ringing call.
 *
 * ## Why this one carries more than an id, unlike `NotificationMessage`
 *
 * Every other personal-room message in this file is deliberately minimal: an
 * id, and the client refetches over authorized HTTP. That is right when the
 * client's reaction is to invalidate a query. It is wrong here, because the
 * reaction is to make a noise and show a face RIGHT NOW, and a refetch adds a
 * round trip to the one message in this system whose whole value is latency.
 *
 * So it carries the three things the banner renders from and nothing else: the
 * session to answer, the conversation it belongs to, and who is calling — as an
 * ID, which the client resolves through the org directory it already has. No
 * name, no avatar URL, no channel name: a room message is the easiest thing in
 * this system to end up in a browser console, and a private channel's name is
 * exactly what its non-members must not learn.
 */
export interface CallRingingMessage {
  readonly sessionId: string;
  readonly channelId: string;
  readonly initiatedBy: string;
  readonly kind: string;
}

/**
 * "Stop ringing" — the call is over.
 *
 * Its own message rather than a status field on the one above, because the
 * client's reaction is completely different (silence the tone, drop the banner)
 * and a single handler branching on a status is the shape where the branch that
 * never fires is the one that stops the noise.
 */
export interface CallEndedMessage {
  readonly sessionId: string;
  readonly reason: string;
}

/** Server-to-client events, named for `io.on`/`socket.on` type inference. */
export interface ServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  broadcast: (message: BroadcastMessage) => void;
  notification: (message: NotificationMessage) => void;
  /* In-app voice ringing (Phase 13). On the DEFAULT namespace, not `/rtc`,
     because `user:{userId}` lives here and because a phone has to ring on a
     socket the client already holds open rather than on one it connects when
     it opens a call — which would be after the call it is meant to announce. */
  'call:ringing': (message: CallRingingMessage) => void;
  'call:ended': (message: CallEndedMessage) => void;
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

/**
 * The Socket.io room name for one person's personal notifications (§3.5).
 *
 * Every authenticated socket on the default namespace is joined to its OWN
 * `user:{userId}` room at connection time (`gateway.ts`) — the id comes from
 * `socket.data.identity`, set at the handshake, never from a client
 * request. There is no `userJoin`/`userLeave` client event because there is
 * nothing to request: this room's membership is exactly "connections
 * authenticated as this user," which the handshake already decided.
 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
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

export const TypingRequestSchema: z.ZodType<TypingRequest, z.ZodTypeDef, { channelId: string }> = z
  .object({ channelId: ChannelIdSchema })
  .strict();

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

/** Who currently has this conversation open. See `gateway.ts` on DMs. */
export interface ChannelPresenceMessage {
  readonly channelId: string;
  readonly userIds: readonly string[];
}

export interface ChatServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  presence: (message: ChannelPresenceMessage) => void;
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

/* -------------------------------------------------------------------------- *
 * Calls (Phase 7 Wave 2, ai/phase-7-voice.md §3.10)
 * -------------------------------------------------------------------------- */

/**
 * "Subscribe me to this call's state."
 *
 * The same two fields and the same absence as every other join request in this
 * file: an org and a resource, `.strict()`, and NO subject. The reasoning is
 * identical and it is not repeated here by accident — this is the third join
 * type, and the shape being uniform is what makes "there is nowhere in the
 * protocol to assert an identity" a property of the protocol rather than of
 * three separately-remembered handlers.
 *
 * A call id is `z.string().uuid()` rather than a branded parser because there
 * is no `CallIdSchema` in contracts — calls are identified by an opaque id the
 * server minted, and the room is validated against the database anyway
 * (`authorizeCallJoin`), which is a stronger check than a shape.
 */
export interface CallJoinRequest {
  readonly orgId: OrgId;
  readonly callId: string;
}

/** Annotated rather than inferred — see the note on `JoinRequestSchema`. */
export const CallJoinRequestSchema: z.ZodType<
  CallJoinRequest,
  z.ZodTypeDef,
  { orgId: string; callId: string }
> = z.object({ orgId: OrgIdSchema, callId: z.string().uuid() }).strict();

export interface CallLeaveRequest {
  readonly callId: string;
}

export const CallLeaveRequestSchema: z.ZodType<CallLeaveRequest, z.ZodTypeDef, { callId: string }> =
  z.object({ callId: z.string().uuid() }).strict();

/**
 * A call changed state.
 *
 * Carries the STATUS and nothing else — no phone number, no recording URL. The
 * client already knows which call it subscribed to, and a room message is the
 * easiest thing in this system to end up in a browser console or a client-side
 * log. `apps/web` reacts by invalidating its call queries (the INVALIDATE
 * strategy ai/phase-4-realtime.md §5 establishes), not by rendering this.
 */
export interface CallStateMessage {
  readonly callId: string;
  readonly status: string;
  readonly at: string;
}

export interface CallServerToClientEvents {
  'call:state': (message: CallStateMessage) => void;
}

export interface CallClientToServerEvents {
  'call:join': (request: CallJoinRequest, ack: (result: JoinAck) => void) => void;
  'call:leave': (request: CallLeaveRequest) => void;
}

/** The Socket.io room name for a call. One definition, used on both sides. */
export function callRoom(callId: string): string {
  return `call:${callId}`;
}

/** The inverse of `channelRoom`, or null if the room is not a channel room. */
export function channelIdOfRoom(room: string): string | null {
  return room.startsWith('channel:') ? room.slice('channel:'.length) : null;
}

/** The namespace chat is served on. One definition, used by both sides. */
export const CHAT_NAMESPACE = '/chat';

/* -------------------------------------------------------------------------- *
 * In-app voice signalling (Phase 13 Wave 1, ai/phase-13-webrtc.md §3.1, §3.2)
 *
 * Its OWN namespace and its own event maps, for the reason the chat section
 * above gives: two maps mean an RTC signal cannot be delivered to a chat
 * listener even by mistake. The handshake is the same `verifyHandshake`, so this
 * phase adds zero new authentication code — the third time that sentence is
 * true in this file, which is the point.
 *
 * ## THE RELAY NEVER TRUSTS A PEER ID IN THE PAYLOAD
 *
 * `RtcSignalRequest` carries a `to`, and it is the one field in this file that
 * would be a vulnerability if it were used the obvious way. It is a SELECTOR
 * over the room's roster — which the server holds — and never a routing key. See
 * `gateway.ts`'s `rtc:signal` handler; the wrong implementation is written down
 * there so it is recognizable.
 *
 * `from` is absent from the request and present on the message. That asymmetry
 * is the whole identity rule of this file applied to a payload that genuinely
 * has to name a person: the server fills it in from `socket.data.identity`.
 * -------------------------------------------------------------------------- */

/**
 * "Subscribe me to this call's signalling."
 *
 * The same two fields and the same absence as every other join request here: an
 * org, a resource, `.strict()`, and NO subject.
 */
export interface RtcJoinRequest {
  readonly orgId: OrgId;
  readonly sessionId: string;
}

/** Annotated rather than inferred — see the note on `JoinRequestSchema`. */
export const RtcJoinRequestSchema: z.ZodType<
  RtcJoinRequest,
  z.ZodTypeDef,
  { orgId: string; sessionId: string }
> = z.object({ orgId: OrgIdSchema, sessionId: z.string().uuid() }).strict();

export interface RtcLeaveRequest {
  readonly sessionId: string;
}

export const RtcLeaveRequestSchema: z.ZodType<
  RtcLeaveRequest,
  z.ZodTypeDef,
  { sessionId: string }
> = z.object({ sessionId: z.string().uuid() }).strict();

/**
 * The upper bound on one signalling payload.
 *
 * A full SDP offer with a dozen ICE candidates runs to a few kilobytes; 32 KB is
 * generous for that and still bounded. Unbounded, this field is a memory
 * amplifier one authorized peer can point at another — the room already trusts
 * them enough to deliver it, which is exactly why the size has to be checked
 * rather than assumed.
 */
export const MAX_SIGNAL_CHARS = 32_768;

/**
 * One WebRTC signalling message, addressed to a peer.
 *
 * `data` is an opaque string, deliberately not a parsed SDP or a candidate
 * object. The gateway has no business understanding the media negotiation it
 * carries, and a schema that modelled SDP would have to be updated every time a
 * browser adds a field — failing closed on a payload that was perfectly valid.
 * It is relayed byte-for-byte and never persisted.
 */
export interface RtcSignalRequest {
  readonly sessionId: string;
  /** A user id. A SELECTOR over the room roster, never a routing key. */
  readonly to: string;
  readonly kind: 'offer' | 'answer' | 'candidate';
  readonly data: string;
}

export const RtcSignalRequestSchema: z.ZodType<
  RtcSignalRequest,
  z.ZodTypeDef,
  { sessionId: string; to: string; kind: 'offer' | 'answer' | 'candidate'; data: string }
> = z
  .object({
    sessionId: z.string().uuid(),
    to: z.string().uuid(),
    kind: z.enum(['offer', 'answer', 'candidate']),
    data: z.string().max(MAX_SIGNAL_CHARS),
  })
  .strict();

/**
 * A signal from another peer.
 *
 * `from` is filled in by the gateway from the sender's own
 * `socket.data.identity`, never from their request — the same rule as `typing`,
 * and load-bearing in a stronger way here: a client that could name its own
 * `from` could impersonate another participant's offer and take over their leg
 * of the call.
 */
export interface RtcSignalMessage {
  readonly sessionId: string;
  readonly from: string;
  readonly kind: 'offer' | 'answer' | 'candidate';
  readonly data: string;
}

/**
 * Who is currently in this call's signalling room.
 *
 * The full list, not a delta — the same reasoning `PresenceMessage` gives. A
 * mesh client uses it to decide which peer connections to open, and
 * reconstructing "who is here" from a stream of joins and leaves means one
 * missed message leaves a peer permanently unconnected to somebody.
 *
 * This is ROOM occupancy, not the authoritative participant list: the database
 * is that (`rtc.participants`), and a client renders the roster from the API.
 * Two things, deliberately not merged — one says who to negotiate with right
 * now, the other says who was invited.
 */
export interface RtcPeersMessage {
  readonly sessionId: string;
  readonly userIds: readonly string[];
}

/** The gateway removed this socket from a call room it had joined. */
export interface RtcClosedMessage {
  readonly sessionId: string;
}

export interface RtcServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  'rtc:peers': (message: RtcPeersMessage) => void;
  'rtc:signal': (message: RtcSignalMessage) => void;
  'rtc:closed': (message: RtcClosedMessage) => void;
  'session:ended': (message: SessionEndedMessage) => void;
}

export interface RtcClientToServerEvents {
  'rtc:join': (request: RtcJoinRequest, ack: (result: JoinAck) => void) => void;
  'rtc:leave': (request: RtcLeaveRequest) => void;
  'rtc:signal': (request: RtcSignalRequest) => void;
}

/**
 * The Socket.io room name for a call session.
 *
 * Prefixed `rtc:` rather than `call:`, which Phase 7 already took for PSTN call
 * state on the chat namespace. Two different things named `call:{uuid}` in one
 * process is the kind of collision that only shows up when both ids happen to
 * exist, which is to say in production.
 */
export function rtcRoom(sessionId: string): string {
  return `rtc:${sessionId}`;
}

/** The namespace in-app voice signalling is served on. */
export const RTC_NAMESPACE = '/rtc';
