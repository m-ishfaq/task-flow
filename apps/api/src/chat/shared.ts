import { eq, schema, type withOrgScope } from '@taskflow/db';
import {
  errors,
  type ChannelId,
  type MessageId,
  type OrgId,
  type RequestId,
  type UserId,
} from '@taskflow/contracts';
import { can, enforce, type Permission, type ResourceRef, type Subject } from '@taskflow/policy';

/**
 * Shared plumbing for the Chat services (PLAN.md §3.2; ai/phase-5-chat.md §3.3).
 *
 * ## The one idea in this file
 *
 * A channel is either OPEN to the organization or CLOSED to everyone without a
 * relation on it, and which one it is comes from the row. `channelTarget()`
 * below is the single place that translates a loaded channel into the
 * `can()` target that says so, and every authorization decision about a channel
 * — in this app and in the socket gateway — goes through it.
 *
 * That matters because the failure it prevents is invisible. `member` holds
 * `channel:read` from the role matrix, so a target built WITHOUT `closed` makes
 * `can()` answer "allowed" for every private channel and every DM in the
 * organization, with a decision trace that looks entirely correct: the role
 * really does grant the permission, and there really is no tuple to weigh
 * against it. Nothing throws, nothing logs, and the product appears to work.
 *
 * So the rule is: never build a channel `Target` inline. Call `channelTarget`.
 */

export interface ChatActor {
  /** Role and resolved tuples, from `subjectOf(ctx.principal)`. */
  readonly subject: Subject;
  readonly requestId: RequestId;
}

export function orgOf(actor: ChatActor): OrgId {
  return actor.subject.orgId;
}

export function userOf(actor: ChatActor): UserId {
  return actor.subject.userId;
}

/** Envelope for an event write — see the Work equivalent on why this is a helper. */
export function envelopeOf(actor: ChatActor): {
  readonly orgId: OrgId;
  readonly actorId: UserId;
  readonly requestId: RequestId;
} {
  return { orgId: actor.subject.orgId, actorId: actor.subject.userId, requestId: actor.requestId };
}

/* -------------------------------------------------------------------------- *
 * Channels
 * -------------------------------------------------------------------------- */

/** The channel fields every authorization decision needs. */
export interface ChannelRow {
  readonly id: string;
  readonly orgId: string;
  readonly type: string;
  readonly name: string | null;
  readonly topic: string | null;
  readonly archivedAt: Date | null;
  /** Days after which messages are deleted. Null means keep forever. */
  readonly retentionDays: number | null;
  /** Blanket legal hold — exempts everything here from the retention sweep. */
  readonly retentionHold: boolean;
}

/**
 * True when a channel is reachable only through a relation on it.
 *
 * Public channels are open to the org — that is what "public" means, and it is
 * why `member` holds `channel:read` at all. Everything else (private channels,
 * DMs, group DMs) is closed, and the org role reaches none of it.
 *
 * Written as "not public" rather than as a list of the closed types on purpose.
 * The two are equivalent today and stop being equivalent the moment a fifth
 * channel type is added: an inclusive list defaults a new type to CLOSED, which
 * is a visible bug someone reports, while an exclusive list would default it to
 * open, which is a silent disclosure nobody reports.
 */
export function isClosedChannel(channel: { readonly type: string }): boolean {
  return channel.type !== 'public';
}

/**
 * The `can()` target for a channel.
 *
 * A channel has no ancestors: there is no container a grant could name that
 * reaches it, because channels do not nest and are not owned by a project. The
 * empty chain is passed explicitly rather than omitted so that a reader does not
 * have to wonder whether it was forgotten.
 */
export function channelTarget(channel: ChannelRow): {
  readonly orgId: OrgId;
  readonly resource: ResourceRef;
  readonly ancestors: readonly ResourceRef[];
  readonly closed: boolean;
} {
  return {
    /* The org from the ROW, never from the request — `Target.orgId` is
       documented as exactly that, and it is what makes the engine's
       cross-tenant check a comparison of two independent values rather than of
       a value with itself. */
    orgId: channel.orgId as OrgId,
    resource: { type: 'channel', id: channel.id },
    ancestors: [],
    closed: isClosedChannel(channel),
  };
}

/**
 * What this caller may do in this channel.
 *
 * ## Why the SERVER answers this
 *
 * CLAUDE.md §8.2 says the UI never re-derives authorization, and that rule
 * exists because a client that recomputes `can()` produces a second model which
 * drifts from the real one — and the drifted copy is the one users see. The
 * usual consequence is that every control is rendered and the server refuses
 * what it must.
 *
 * That is honest but it is not kind: a member who cannot moderate is offered a
 * Delete button whose only possible outcome is an error toast, on every message
 * anyone else wrote. The fix is not to move the decision into the browser — it
 * is to have the server SEND its decision, computed by the same `can()` on the
 * same `Subject` as the enforcement itself. One model, two consumers: `enforce`
 * throws on it, and this reports it.
 *
 * So a client may hide a control it is told it does not have, and still never
 * decides anything: if this and the enforcement ever disagreed, the enforcement
 * is what would refuse the request.
 *
 * `post` is not `channel:read`. Someone with a `viewer` tuple on a channel can
 * read every message in it and write none — that is the whole reason the
 * relation exists — so a composer hidden on `channel:read` would be hidden from
 * nobody and shown to people who cannot use it.
 */
export interface ChannelCapabilities {
  /** Rename, set a topic, archive, add and remove members. */
  readonly manage: boolean;
  /** Delete someone ELSE's message. Deleting your own needs only `post`. */
  readonly moderate: boolean;
  /** Post a message. */
  readonly post: boolean;
}

export function capabilitiesFor(actor: ChatActor, channel: ChannelRow): ChannelCapabilities {
  const target = channelTarget(channel);

  /* An archived channel accepts no new messages, and the service refuses a
     send into one. Reported here so the composer can say so rather than
     letting someone type a message that cannot land. */
  const live = channel.archivedAt === null;

  return {
    manage: can(actor.subject, 'channel:manage', target).allowed,
    moderate: can(actor.subject, 'message:delete', target).allowed,
    post: live && can(actor.subject, 'message:create', target).allowed,
  };
}

/** Layer 2 for a loaded channel. Throws the tRPC error `enforce` produces. */
export function enforceOnChannel(
  actor: ChatActor,
  permission: Permission,
  channel: ChannelRow,
): void {
  enforce(actor.subject, permission, channelTarget(channel));
}

type ChatTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * Loads a channel, or throws NOT_FOUND.
 *
 * NOT_FOUND rather than FORBIDDEN for a channel in another tenant is not a
 * choice made here — RLS has already erased the distinction, because a channel
 * outside this org is simply not among the rows this scope can see.
 */
export async function loadChannel(tx: ChatTx, channelId: ChannelId): Promise<ChannelRow> {
  const rows = await tx
    .select({
      id: schema.channels.id,
      orgId: schema.channels.orgId,
      type: schema.channels.type,
      name: schema.channels.name,
      topic: schema.channels.topic,
      archivedAt: schema.channels.archivedAt,
      retentionDays: schema.channels.retentionDays,
      retentionHold: schema.channels.retentionHold,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);

  const channel = rows[0];
  if (!channel) throw errors.notFound();
  return channel;
}

/**
 * Confirms a message exists, is not deleted, and belongs to THIS channel —
 * the guard every Wave 2 write (react, pin, mark-read) applies before
 * touching a row that references the message. Without it, the composite
 * foreign key each child table carries would still refuse a cross-channel
 * write, but as a raw constraint violation surfacing as INTERNAL_ERROR
 * rather than a reason a caller can act on.
 */
export async function assertMessageInChannel(
  tx: ChatTx,
  channelId: ChannelId,
  messageId: MessageId,
): Promise<void> {
  const rows = await tx
    .select({ channelId: schema.messages.channelId, deletedAt: schema.messages.deletedAt })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (message?.channelId !== channelId || message.deletedAt !== null) {
    throw errors.notFound();
  }
}

/* Membership lives in `membership.ts` — it is a repository, and keeping the
   tuple writes out of a `*.service.ts` file is what guardrail 11's scope means
   by "repositories mutate by design". See that file's header. */

/** The message fields the attachment path needs to authorize against. */
export interface MessageRow {
  readonly id: string;
  readonly orgId: string;
  readonly channelId: string;
  readonly authorId: string | null;
  readonly deletedAt: Date | null;
}

/**
 * Loads a message, or throws NOT_FOUND.
 *
 * Returns the CHANNEL id because that is what every authorization decision
 * about a message actually consults — a message has no independent
 * authorization, it is readable exactly when its channel is. Callers that skip
 * the channel and enforce on the message would be asking `can()` about a
 * resource no tuple ever points at, which answers from the org role alone.
 */
export async function loadMessageRow(tx: ChatTx, messageId: MessageId): Promise<MessageRow> {
  const rows = await tx
    .select({
      id: schema.messages.id,
      orgId: schema.messages.orgId,
      channelId: schema.messages.channelId,
      authorId: schema.messages.authorId,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (!message) throw errors.notFound();
  return message;
}
