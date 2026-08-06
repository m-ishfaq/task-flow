import { and, asc, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type ChannelId, type MessageId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import {
  channelGuestChanged,
  channelRetentionChanged,
  complianceExported,
  legalHoldChanged,
} from './events.js';
import {
  enforceOnChannel,
  envelopeOf,
  isClosedChannel,
  loadChannel,
  loadMessageRow,
  orgOf,
  userOf,
  type ChatActor,
} from './shared.js';
import {
  addChannelMemberTuple,
  removeChannelMemberTuple,
  CHANNEL_MEMBER_RELATION,
  CHANNEL_OBJECT_TYPE,
} from './membership.js';

/**
 * Retention policy, legal hold, guest access and compliance export
 * (Wave 4, ai/phase-5-chat.md §3.7, §3.8).
 *
 * ⚠ Adjacent to a human-review surface: `setGuestAccess` writes relationship
 * tuples, which are the input to `can()`. A guest written wrongly is not a
 * broken feature, it is an outsider inside a private channel.
 *
 * ## Everything here is `channel:manage`, except export
 *
 * Setting a retention window destroys data on a schedule. Placing a hold
 * preserves it against that schedule. Inviting a guest lets somebody outside
 * the organization read a channel. All three are administration of the channel,
 * so all three are `channel:manage` — the same permission that renames it,
 * which is deliberate: a person trusted to decide who is in a channel is the
 * person trusted to decide how long it is kept.
 *
 * Export is `audit:export`, not `channel:manage`. Taking a copy of an entire
 * conversation is a compliance capability rather than a channel-administration
 * one, and the people who run exports are not the people who run channels.
 */

/* -------------------------------------------------------------------------- *
 * Retention
 * -------------------------------------------------------------------------- */

export async function setRetention(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly retentionDays: number | null },
): Promise<{ readonly retentionDays: number | null }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:manage', channel);

    const current = await tx
      .select({ retentionDays: schema.channels.retentionDays })
      .from(schema.channels)
      .where(eq(schema.channels.id, input.channelId))
      .limit(1);

    const before = current[0]?.retentionDays ?? null;
    if (before === input.retentionDays) return { retentionDays: before };

    await tx
      .update(schema.channels)
      .set({ retentionDays: input.retentionDays, updatedAt: new Date() })
      .where(eq(schema.channels.id, input.channelId));

    await outboxWriter.append(tx, [
      createEvent(
        channelRetentionChanged,
        { channelId: input.channelId, before, after: input.retentionDays },
        envelopeOf(actor),
      ),
    ]);

    return { retentionDays: input.retentionDays };
  });
}

/* -------------------------------------------------------------------------- *
 * Legal hold
 * -------------------------------------------------------------------------- */

/**
 * Holds or releases an entire channel.
 *
 * A channel hold covers messages written AFTER it was placed, which a
 * per-message flag cannot express — that is why both exist rather than one.
 */
export async function setChannelHold(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly held: boolean },
): Promise<{ readonly held: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:manage', channel);

    await tx
      .update(schema.channels)
      .set({ retentionHold: input.held, updatedAt: new Date() })
      .where(eq(schema.channels.id, input.channelId));

    await outboxWriter.append(tx, [
      createEvent(
        legalHoldChanged,
        {
          channelId: input.channelId,
          messageId: null,
          scope: 'channel' as const,
          held: input.held,
        },
        envelopeOf(actor),
      ),
    ]);

    return { held: input.held };
  });
}

/**
 * Holds or releases one message.
 *
 * A hold may be placed on a message that is already past its channel's
 * retention window — §7.5's open question, answered yes. The sweep deletes on a
 * tick rather than at the instant of expiry, so a message past its window still
 * exists until the next pass, and refusing to hold it would mean the one moment
 * a hold is most urgently needed is the moment it is unavailable.
 */
export async function setMessageHold(
  actor: ChatActor,
  input: { readonly messageId: MessageId; readonly held: boolean },
): Promise<{ readonly held: boolean; readonly applied: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const message = await loadMessageRow(tx, input.messageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);
    enforceOnChannel(actor, 'channel:manage', channel);

    /* `applied` reports whether a row was actually written, and it is not
       cosmetic. A hold placed on a message the retention sweep removed a moment
       earlier updates ZERO rows and would otherwise return success — telling
       whoever placed it that evidence is preserved when it is already gone.
       That is the worst possible thing for this call to be wrong about.

       It is also what makes the race testable: "a hold that applied implies the
       message still exists" is an invariant only the delete-with-hold-check-
       inline implementation satisfies. A two-step sweep can apply a hold and
       then delete the row it just held, and without this field the test cannot
       tell that from the legitimate case where the sweep simply won. */
    const written = await tx
      .update(schema.messages)
      .set({
        heldAt: input.held ? new Date() : null,
        heldBy: input.held ? userOf(actor) : null,
      })
      .where(eq(schema.messages.id, input.messageId))
      .returning({ id: schema.messages.id });

    const applied = written.length > 0;

    await outboxWriter.append(tx, [
      createEvent(
        legalHoldChanged,
        {
          channelId: message.channelId,
          messageId: input.messageId,
          scope: 'message' as const,
          held: input.held,
        },
        envelopeOf(actor),
      ),
    ]);

    return { held: input.held, applied };
  });
}

/* -------------------------------------------------------------------------- *
 * Guest access (§3.8)
 * -------------------------------------------------------------------------- */

export interface ChannelGuestRow {
  readonly userId: string;
  readonly expiresAt: Date | null;
}

/**
 * Everyone currently holding GUEST access to this channel — the invite
 * panel's own roster, separate from `channelMemberIds`'s full list because
 * that one does not carry `is_guest` and mixing the two questions ("who is
 * in this channel" vs "who is in this channel as a guest, and until when")
 * into one query would make the panel guess which rows to highlight.
 *
 * `channel:manage`, same as `setGuestAccess` itself — deciding who to revoke
 * needs the same trust as deciding who to invite.
 */
export async function listChannelGuests(
  actor: ChatActor,
  input: { readonly channelId: ChannelId },
): Promise<readonly ChannelGuestRow[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:manage', channel);

    return tx
      .select({
        userId: schema.relationshipTuples.subjectId,
        expiresAt: schema.relationshipTuples.expiresAt,
      })
      .from(schema.relationshipTuples)
      .where(
        and(
          eq(schema.relationshipTuples.subjectType, 'user'),
          eq(schema.relationshipTuples.relation, CHANNEL_MEMBER_RELATION),
          eq(schema.relationshipTuples.objectType, CHANNEL_OBJECT_TYPE),
          eq(schema.relationshipTuples.objectId, input.channelId),
          eq(schema.relationshipTuples.isGuest, true),
        ),
      );
  });
}

/**
 * Grants or revokes a guest's access to ONE channel.
 *
 * ## A guest is a tuple, not a role
 *
 * `GUEST` grants nothing from the role alone — `packages/policy/src/roles.ts`
 * has it as an empty list, and the comment there says exactly why: "a guest who
 * somehow reaches a resource with no tuple gets a denial from the default path,
 * not from a special case someone has to remember to write." So guest access IS
 * the `member` tuple on a specific channel, marked `is_guest` for review, and
 * nothing else changes.
 *
 * That is why §3.8's warning — do not add a chat-package-local `if (isGuest)`
 * check — costs nothing to obey here: there is no branch to write. The same
 * `can()` that admits a member admits a guest, on the one channel they hold.
 *
 * ## Guests cannot be added to a DM
 *
 * §7.4, answered: channels only. A DM's participants are fixed at creation
 * anyway, so this refusal is consistent with `addChannelMember`'s — but it is
 * stated separately because the reasoning differs. A DM refuses new members
 * because its history was written for two people; a guest is refused because
 * channel-scoped access is the whole definition of a guest, and "a guest who
 * can DM anyone in the org" is an external party with a messaging channel into
 * a company that invited them to one conversation.
 *
 * ## Expiry is enforced by the loader, not by a sweep
 *
 * `expiresAt` lives on the tuple and `loadTuples` excludes lapsed rows in its
 * WHERE clause. A contractor's access therefore stops working at the moment it
 * lapses rather than whenever a cleanup job next runs — which is the difference
 * between an access window and an access suggestion.
 */
export async function setGuestAccess(
  actor: ChatActor,
  input: {
    readonly channelId: ChannelId;
    readonly userId: UserId;
    readonly granted: boolean;
    /** When the access lapses. Null means it does not. */
    readonly expiresAt: Date | null;
  },
): Promise<{ readonly granted: boolean }> {
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:manage', channel);

    if (channel.type === 'dm' || channel.type === 'group_dm') {
      throw errors.validation({
        channelId: 'Guests are channel-scoped and cannot be added to a direct message.',
      });
    }

    /* A guest in a PUBLIC channel is a contradiction worth refusing: public
       means readable by the organization, and a guest holds no org membership,
       so the tuple would be the only thing granting them access — which is a
       private channel with a misleading label. Invite them to a private one. */
    if (!isClosedChannel(channel)) {
      throw errors.validation({
        channelId: 'Guests can only be invited to private channels.',
      });
    }

    if (input.granted) {
      await addChannelMemberTuple(tx, {
        orgId,
        channelId: input.channelId,
        userId: input.userId,
        grantedBy: userOf(actor),
        isGuest: true,
        expiresAt: input.expiresAt,
      });
    } else {
      await removeChannelMemberTuple(tx, {
        channelId: input.channelId,
        userId: input.userId,
      });
    }

    await outboxWriter.append(tx, [
      createEvent(
        channelGuestChanged,
        {
          channelId: input.channelId,
          userId: input.userId,
          granted: input.granted,
          expiresAt: input.expiresAt === null ? null : input.expiresAt.toISOString(),
        },
        envelopeOf(actor),
      ),
    ]);

    return { granted: input.granted };
  });
}

/* -------------------------------------------------------------------------- *
 * Compliance export
 * -------------------------------------------------------------------------- */

export interface ExportedMessage {
  readonly messageId: string;
  readonly authorId: string | null;
  readonly bodyText: string;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly heldAt: Date | null;
}

/**
 * The full contents of one channel, for a compliance request.
 *
 * ## `audit:export`, and the export is itself audited
 *
 * Taking a copy of a private conversation is among the most sensitive things
 * this product can do, and it leaves no other trace — the caller receives the
 * data and the channel looks untouched. `compliance.exported` is what makes it
 * visible, and it records the count rather than the contents for the reason
 * every other payload here does: an outbox row is replayed into a log that
 * keeps whatever is put in it.
 *
 * ## Deleted messages are included, and that is the point
 *
 * A tombstone's body is withheld from ordinary reads (`listMessages` strips
 * it), because "delete" must mean the message is gone for the people in the
 * channel. An export answering a legal request is the one caller for which that
 * is wrong: the question being asked is what was said, including what somebody
 * later removed. `includesDeleted` is on the event so the audit trail records
 * which kind of export was taken.
 *
 * Text, not the TipTap document. An export is read by people and by tools that
 * are not this application, and handing them a node tree to interpret would
 * make the export's meaning depend on a renderer they do not have.
 */
export async function exportChannel(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly includeDeleted?: boolean },
): Promise<{
  readonly channelId: string;
  readonly channelName: string | null;
  readonly exportedAt: Date;
  readonly messages: readonly ExportedMessage[];
}> {
  const includeDeleted = input.includeDeleted ?? true;

  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);

    /* `audit:export` is an ORG capability — it is not held on a channel, and a
       tuple cannot grant it. So this is enforced against the channel target
       like everything else here, which means an exporter must ALSO be able to
       reach the channel: `enforce` answers 404 for a private channel they hold
       no tuple on. That is deliberate. "Compliance can export anything" is a
       reasonable policy and this is not it — the audited path to a channel
       nobody in compliance belongs to is to be added to it first, visibly. */
    enforceOnChannel(actor, 'audit:export', channel);

    const rows = await tx
      .select({
        messageId: schema.messages.id,
        authorId: schema.messages.authorId,
        bodyText: schema.messages.bodyText,
        createdAt: schema.messages.createdAt,
        editedAt: schema.messages.editedAt,
        deletedAt: schema.messages.deletedAt,
        heldAt: schema.messages.heldAt,
      })
      .from(schema.messages)
      .where(
        includeDeleted
          ? eq(schema.messages.channelId, input.channelId)
          : and(eq(schema.messages.channelId, input.channelId), isNull(schema.messages.deletedAt)),
      )
      .orderBy(asc(schema.messages.id));

    await outboxWriter.append(tx, [
      createEvent(
        complianceExported,
        {
          channelId: input.channelId,
          messageCount: rows.length,
          includesDeleted: includeDeleted,
        },
        envelopeOf(actor),
      ),
    ]);

    return {
      channelId: channel.id,
      channelName: channel.name,
      exportedAt: new Date(),
      messages: rows,
    };
  });
}
