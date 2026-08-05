import { and, eq, inArray, schema, type withOrgScope } from '@taskflow/db';
import type { ChannelId, OrgId, UserId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';

/**
 * Channel membership — reading and writing the tuples that grant channel access.
 *
 * ⚠ Adjacent to a human-review surface: every write here produces a row that
 * `can()` reads. A membership written wrongly is not a broken feature, it is
 * access to a private conversation.
 *
 * ## Why this is not a `*.service.ts` file
 *
 * Guardrail 11 requires every state-mutating SERVICE method to emit a domain
 * event, and the rule is scoped to service files by name — a `services`
 * directory, or a `.service.ts` suffix — precisely so that repositories, which
 * mutate by design, are not forced to invent an event per row they touch.
 * `rebalance.ts` and `counters.ts` are the existing examples on the Work side.
 *
 * This file is that same shape. `addChannelMemberTuple` writes one row; the
 * EVENT belongs to the operation a person performed — creating a channel,
 * opening a DM, adding a colleague — and `channel.service.ts` emits it there,
 * where the actor and their intent are known. A `member.tuple_written` event
 * emitted from here would be a second, lower-level record of the same fact, and
 * two audit entries per membership change is worse than one.
 *
 * ## Membership is a tuple, not a table
 *
 * There is no `chat.channel_members` — migration 0017 argues this at length.
 * The short version: `can()` already reads tuples, Phase 4's revocation path
 * already force-leaves sockets when a grant changes, and `packages/policy`'s
 * `member` relation was written in Phase 2 for exactly this.
 */

type ChatTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * The relation that expresses "is in this channel".
 *
 * One constant rather than the literal repeated at each call site. A typo in one
 * of them writes a membership that grants nothing and is invisible in every
 * decision trace — `loadTuples` filters unrecognized relations out before the
 * engine sees them, so the row exists, looks right in the table, and does
 * nothing.
 */
export const CHANNEL_MEMBER_RELATION = 'member';

/** The resource type a channel tuple names. Same reasoning as the relation. */
export const CHANNEL_OBJECT_TYPE = 'channel';

/** Every user id with a `member` tuple on this channel. */
export async function channelMemberIds(
  tx: ChatTx,
  channelId: ChannelId,
): Promise<readonly string[]> {
  const rows = await tx
    .select({ subjectId: schema.relationshipTuples.subjectId })
    .from(schema.relationshipTuples)
    .where(
      and(
        eq(schema.relationshipTuples.subjectType, 'user'),
        eq(schema.relationshipTuples.relation, CHANNEL_MEMBER_RELATION),
        eq(schema.relationshipTuples.objectType, CHANNEL_OBJECT_TYPE),
        eq(schema.relationshipTuples.objectId, channelId),
      ),
    );

  return rows.map((row) => row.subjectId);
}

/**
 * True when this user holds a `member` tuple on this channel.
 *
 * Deliberately NOT an authorization check, and not used as one. `can()` decides
 * who may read a channel; this answers the different, product-level question of
 * whether someone is already in it — which `addChannelMember` needs so adding an
 * existing member is idempotent, and which the channel list needs to render
 * "joined" state. Using it in place of `can()` would be the inline participant
 * check ai/phase-5-chat.md §3.3 exists to forbid.
 */
export async function isChannelMember(
  tx: ChatTx,
  channelId: ChannelId,
  userId: UserId,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.relationshipTuples.id })
    .from(schema.relationshipTuples)
    .where(
      and(
        eq(schema.relationshipTuples.subjectType, 'user'),
        eq(schema.relationshipTuples.subjectId, userId),
        eq(schema.relationshipTuples.relation, CHANNEL_MEMBER_RELATION),
        eq(schema.relationshipTuples.objectType, CHANNEL_OBJECT_TYPE),
        eq(schema.relationshipTuples.objectId, channelId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/** The members of several channels at once, grouped by channel id. */
export async function membersOfChannels(
  tx: ChatTx,
  channelIds: readonly string[],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const byChannel = new Map<string, Set<string>>();
  if (channelIds.length === 0) return byChannel;

  const rows = await tx
    .select({
      channelId: schema.relationshipTuples.objectId,
      userId: schema.relationshipTuples.subjectId,
    })
    .from(schema.relationshipTuples)
    .where(
      and(
        eq(schema.relationshipTuples.subjectType, 'user'),
        eq(schema.relationshipTuples.relation, CHANNEL_MEMBER_RELATION),
        eq(schema.relationshipTuples.objectType, CHANNEL_OBJECT_TYPE),
        inArray(schema.relationshipTuples.objectId, channelIds),
      ),
    );

  for (const row of rows) {
    const set = byChannel.get(row.channelId) ?? new Set<string>();
    set.add(row.userId);
    byChannel.set(row.channelId, set);
  }

  return byChannel;
}

/**
 * Writes one channel-membership tuple.
 *
 * The caller must already have made an authorization decision about the
 * channel. Nothing here re-checks it — this is the write, not the gate.
 */
export async function addChannelMemberTuple(
  tx: ChatTx,
  input: {
    readonly orgId: OrgId;
    readonly channelId: ChannelId;
    readonly userId: UserId;
    /** Null when nobody granted it — a DM's participants, a self-join. */
    readonly grantedBy: UserId | null;
  },
): Promise<void> {
  await tx.insert(schema.relationshipTuples).values({
    id: newId<'TupleId'>(),
    /* Written explicitly even though RLS's WITH CHECK would refuse any other
       value. The column is NOT NULL, so omitting it fails the insert rather than
       defaulting to the session's org — a policy constrains what may be written,
       it does not supply it. */
    orgId: input.orgId,
    subjectType: 'user',
    subjectId: input.userId,
    relation: CHANNEL_MEMBER_RELATION,
    objectType: CHANNEL_OBJECT_TYPE,
    objectId: input.channelId,
    grantedBy: input.grantedBy,
    expiresAt: null,
  });
}

/** Removes one channel-membership tuple. Returns whether a row was there. */
export async function removeChannelMemberTuple(
  tx: ChatTx,
  input: { readonly channelId: ChannelId; readonly userId: UserId },
): Promise<boolean> {
  const deleted = await tx
    .delete(schema.relationshipTuples)
    .where(
      and(
        eq(schema.relationshipTuples.subjectType, 'user'),
        eq(schema.relationshipTuples.subjectId, input.userId),
        eq(schema.relationshipTuples.relation, CHANNEL_MEMBER_RELATION),
        eq(schema.relationshipTuples.objectType, CHANNEL_OBJECT_TYPE),
        eq(schema.relationshipTuples.objectId, input.channelId),
      ),
    )
    .returning({ id: schema.relationshipTuples.id });

  return deleted.length > 0;
}
