import { and, asc, eq, inArray, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type ChannelId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { can, enforce } from '@taskflow/policy';
import { newId } from '@taskflow/security';
import {
  channelArchived,
  channelCreated,
  channelMemberAdded,
  channelMemberRemoved,
  channelUpdated,
} from './events.js';
import {
  capabilitiesFor,
  channelTarget,
  enforceOnChannel,
  envelopeOf,
  isClosedChannel,
  loadChannel,
  orgOf,
  userOf,
  type ChannelCapabilities,
  type ChatActor,
} from './shared.js';
import {
  addChannelMemberTuple,
  channelMemberIds,
  isChannelMember,
  membersOfChannels,
  removeChannelMemberTuple,
} from './membership.js';

/**
 * Channels — public, private, and direct messages (PLAN.md §3.2;
 * ai/phase-5-chat.md §3.1, §3.3, §3.9).
 *
 * ⚠ Adjacent to a human-review surface: every function here writes relationship
 * tuples, which are the input to `can()`. A membership written wrongly is not a
 * broken feature, it is access.
 *
 * ## Two authorization questions, deliberately not merged
 *
 * Administering a channel — renaming it, archiving it, deciding who is in it —
 * is `channel:manage`. Reading it is `channel:read`, and posting in it is
 * `message:create`, which any member holds. This is the same split Work's card
 * detail draws between managing a project's vocabulary and filling one in:
 * collapsing them would mean either nobody but an admin can talk, or anyone who
 * can talk can rename the channel and evict its members.
 *
 * ## Membership is a tuple
 *
 * There is no `channel_members` table (migration 0017 argues why at length).
 * Adding someone writes (user, 'member', channel:{id}) to
 * `authz.relationship_tuples`; removing them deletes it. Three consequences
 * worth holding in mind while reading:
 *
 *   * `can()` sees membership for free — tuples are already on the principal.
 *   * Removing someone force-leaves their open socket, because Phase 4's
 *     `revocation.ts` already re-authorizes rooms when a grant changes.
 *   * A DM's participants are not a column. `openDirectMessage` finds an
 *     existing conversation by comparing member SETS, not by reading a field.
 */

export interface ChannelSummary {
  readonly channelId: string;
  readonly type: string;
  readonly name: string | null;
  readonly topic: string | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  /** Whether the caller holds a `member` tuple — renders "joined" state. */
  readonly joined: boolean;
  /**
   * The OTHER participants, for a DM or group DM. Empty for a named channel.
   *
   * A DM has no name — the database refuses one, because a named DM would show
   * up in a channel browser — so a sidebar has nothing to label it with unless
   * it is told who is in it. Without this the list renders "Direct message"
   * for every conversation, which is unusable the moment there are two.
   *
   * The viewer is excluded here rather than in the client: "who is this
   * conversation with" never means "me", and every caller would otherwise
   * filter themselves out identically.
   *
   * Named channels get an empty array rather than their full roster. A sidebar
   * does not render a public channel's members, and sending the roster of every
   * channel in the org on every sidebar load is a payload that grows with the
   * organization for nothing.
   */
  readonly participantIds: readonly string[];
}

/* -------------------------------------------------------------------------- *
 * Reading
 * -------------------------------------------------------------------------- */

/**
 * The channels this caller may see: every live public channel, plus every
 * channel they hold a membership tuple on.
 *
 * The membership half is read from `actor.subject.tuples` rather than from a
 * query, and that is not merely an optimization. Those are the exact tuples
 * `can()` will be handed for every subsequent decision, so a channel that
 * appears in this list is a channel the caller can actually open. Deriving the
 * list from a separate query would create a second notion of membership that
 * agrees with the first almost always — and the case where it disagrees is a
 * channel visible in the sidebar that 404s when clicked.
 */
export interface ChannelList {
  /** Whether the caller may create a channel — the sidebar gates its "new
      channel" control on this rather than re-deriving it from a role. */
  readonly canCreateChannel: boolean;
  readonly channels: readonly ChannelSummary[];
}

export async function listChannels(actor: ChatActor): Promise<ChannelList> {
  const memberChannelIds = actor.subject.tuples
    .filter((tuple) => tuple.object.type === 'channel')
    .map((tuple) => tuple.object.id);

  return withOrgScope(orgOf(actor), async (tx) => {
    /* Selected as `id`, not aliased to `channelId`, so the row IS a
       `ChannelRow` and can be handed to `channelTarget` directly.

       This was a real bug for about an hour: the alias meant `channelTarget`
       read `row.id` as `undefined`, every tuple comparison missed, and every
       private channel vanished from every sidebar — including its own members'.
       The compiler did not object because the aliased object still satisfied
       enough of the shape. Keeping the column names identical to `ChannelRow`
       is what makes the mismatch impossible rather than merely unlikely. */
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
        createdAt: schema.channels.createdAt,
      })
      .from(schema.channels)
      .where(isNull(schema.channels.archivedAt))
      .orderBy(asc(schema.channels.name), asc(schema.channels.id));

    const joinedIds = new Set(memberChannelIds);

    /* Filtered by `can()` itself, not by a rule about channel types.

       This used to be "public, or I hold a tuple", which is right for a MEMBER
       and wrong for a guest: a guest holds no role grants at all (`GUEST` is an
       empty permission list), so `channel:read` on a public channel is denied —
       but a type-based filter never asks, and every public channel appeared in
       an external collaborator's sidebar. The list and the individual read then
       disagreed, which is the exact drift §8.2 warns about, in the direction
       that discloses.

       Asking the engine costs nothing here: `can()` is pure, the tuples are
       already on the subject, and the set of live channels in one org is small.
       A channel a caller cannot open is now, by construction, a channel that
       cannot appear in their list. */
    const visible = rows.filter(
      (row) => can(actor.subject, 'channel:read', channelTarget(row)).allowed,
    );

    /* Rosters for the DMs only, in ONE query rather than per channel. A named
       channel's members are not sent (see `participantIds`), so this reads
       nothing for an org that uses no direct messages. */
    const directIds = visible
      .filter((row) => row.type === 'dm' || row.type === 'group_dm')
      .map((row) => row.id);
    const membersByChannel = await membersOfChannels(tx, directIds);

    const self = userOf(actor);

    /* Whether the caller may CREATE a channel — the same org-level `can()`
       `createChannel` enforces, answered here so the sidebar's "new channel"
       control can be shown or hidden on the server's own verdict instead of
       the client re-deriving it from a role (CLAUDE.md §8.2 — two permission
       models drift, and the one that shows buttons is the one nobody tests).
       A member who cannot create is not offered a CTA whose only outcome is
       FORBIDDEN. */
    const canCreateChannel = can(actor.subject, 'channel:create').allowed;

    return {
      canCreateChannel,
      channels: visible.map((row) => ({
        channelId: row.id,
        type: row.type,
        name: row.name,
        topic: row.topic,
        archivedAt: row.archivedAt,
        createdAt: row.createdAt,
        joined: joinedIds.has(row.id),
        participantIds: [...(membersByChannel.get(row.id) ?? [])].filter((userId) => userId !== self),
      })),
    };
  });
}

/** One channel, with its members. `channel:read` — closed channels need a tuple. */
export async function getChannel(
  actor: ChatActor,
  input: { readonly channelId: ChannelId },
): Promise<{
  readonly channelId: string;
  readonly type: string;
  readonly name: string | null;
  readonly topic: string | null;
  readonly archivedAt: Date | null;
  readonly memberIds: readonly string[];
  readonly capabilities: ChannelCapabilities;
  readonly retentionDays: number | null;
  readonly retentionHold: boolean;
}> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    const memberIds = await channelMemberIds(tx, input.channelId);

    return {
      channelId: channel.id,
      type: channel.type,
      name: channel.name,
      topic: channel.topic,
      archivedAt: channel.archivedAt,
      memberIds,
      /* Computed from the SAME `can()` the enforcement above uses, so the
         client is told the server's decision rather than reaching its own —
         see `capabilitiesFor`. */
      capabilities: capabilitiesFor(actor, channel),
      /* Configuration, not content: shown in the details panel so whoever holds
         `channel:manage` can see what the policy currently is before changing
         it. Harmless to everyone else, who cannot act on it. */
      retentionDays: channel.retentionDays,
      retentionHold: channel.retentionHold,
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Creating
 * -------------------------------------------------------------------------- */

export interface CreateChannelInput {
  readonly type: 'public' | 'private';
  readonly name: string;
  readonly topic?: string | null;
}

/**
 * Creates a named channel. The creator becomes a member.
 *
 * DMs are NOT created here — see `openDirectMessage`. They take participants
 * instead of a name, must be deduplicated against an existing conversation, and
 * have no manage permission, so folding them into this function would produce
 * one with two disjoint halves and a `type` parameter deciding which is live.
 *
 * The creator's membership tuple is written in the SAME transaction as the
 * channel. A private channel that exists with no members is a channel nobody —
 * including its author — can open, and it would be invisible in the list that
 * would let someone fix it.
 */
export async function createChannel(
  actor: ChatActor,
  input: CreateChannelInput,
): Promise<{ readonly channelId: ChannelId }> {
  const channelId = newId<'ChannelId'>();
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  await withOrgScope(orgId, async (tx) => {
    /* No row to load, so this is a plain org-level capability check with no
       target — the route's `permission` already made it, and re-asking here is
       what keeps the service safe to call from a test or a future job that does
       not go through a route. */
    enforce(actor.subject, 'channel:create');

    try {
      await tx.insert(schema.channels).values({
        id: channelId,
        orgId,
        type: input.type,
        name: input.name,
        topic: input.topic ?? null,
        createdBy: userId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.validation({ name: 'A channel with this name already exists.' });
      }
      throw error;
    }

    await addChannelMemberTuple(tx, { orgId, channelId, userId, grantedBy: userId });

    await outboxWriter.append(tx, [
      createEvent(
        channelCreated,
        { channelId, type: input.type, name: input.name, memberCount: 1 },
        envelopeOf(actor),
      ),
      createEvent(channelMemberAdded, { channelId, userId, addedBy: userId }, envelopeOf(actor)),
    ]);
  });

  return { channelId };
}

/**
 * Finds or creates the direct-message channel between the caller and the people
 * they named.
 *
 * ## Find-or-create, not create
 *
 * Two people must have exactly one conversation. Creating a second DM between
 * the same pair splits their history in half with no way to merge it and no
 * error anywhere — each participant sees whichever one their client opened, and
 * messages appear to vanish. There is no unique index that expresses this,
 * because the participant set is not a column, so the deduplication is done here
 * and the cost of getting it wrong is why this function is not just an insert.
 *
 * ## Why the comparison happens in memory
 *
 * "A DM whose member set is exactly these people" is a relational division, and
 * raw SQL is banned outside `packages/db` (guardrail 2's sibling). The candidate
 * set is bounded by the DMs the CALLER is already in — read from their own
 * tuples, which are already loaded — so this reads a handful of rows rather than
 * scanning the org's channels.
 */
export async function openDirectMessage(
  actor: ChatActor,
  input: { readonly userIds: readonly UserId[] },
): Promise<{ readonly channelId: ChannelId; readonly created: boolean }> {
  const orgId = orgOf(actor);
  const self = userOf(actor);

  /* The caller is always a participant. Deduplicated because a client sending
     its own id alongside the other person's is an obvious thing to do, and it
     would otherwise produce a two-person set that never matches an existing
     conversation and creates a duplicate on every call. */
  const participants = [...new Set<string>([self, ...input.userIds])];

  if (participants.length < 2) {
    throw errors.validation({ userIds: 'A direct message needs at least one other person.' });
  }

  const type = participants.length === 2 ? 'dm' : 'group_dm';

  return withOrgScope(orgId, async (tx) => {
    const existing = await findDirectMessage(tx, actor, participants);
    if (existing !== null) return { channelId: existing, created: false };

    /* Everyone named must be a member of this org. Without this check a DM
       could be opened against a user id from another tenant: the tuple would be
       written under THIS org (RLS sees nothing wrong — the row is stamped with
       the caller's org), and the named person would hold a membership tuple in
       an organization they do not belong to. `resolveOrgMembership` would still
       refuse them at request time, so this is not a breach on its own; it is a
       way to write authorization rows about strangers, which is not something a
       chat feature should be able to do. */
    const memberRows = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(
        and(
          inArray(schema.memberships.userId, participants),
          eq(schema.memberships.status, 'active'),
        ),
      );

    if (memberRows.length !== participants.length) {
      throw errors.notFound();
    }

    const channelId = newId<'ChannelId'>();

    await tx.insert(schema.channels).values({
      id: channelId,
      orgId,
      type,
      /* Null, enforced by `channels_name_matches_type`. A DM is named by its
         participants at render time; a named DM would be listable. */
      name: null,
      topic: null,
      createdBy: self,
    });

    for (const userId of participants) {
      await addChannelMemberTuple(tx, {
        orgId,
        channelId,
        userId: userId as UserId,
        /* Null rather than the opener's id: nobody "added" anyone to a DM, they
           are its participants. Recording the opener as the granter would read,
           in an access review, as one person having granted another access to a
           private conversation. */
        grantedBy: null,
      });
    }

    await outboxWriter.append(tx, [
      createEvent(
        channelCreated,
        { channelId, type, name: null, memberCount: participants.length },
        envelopeOf(actor),
      ),
      ...participants.map((userId) =>
        createEvent(channelMemberAdded, { channelId, userId, addedBy: null }, envelopeOf(actor)),
      ),
    ]);

    return { channelId, created: true };
  });
}

/* -------------------------------------------------------------------------- *
 * Updating
 * -------------------------------------------------------------------------- */

/**
 * Renames a channel or changes its topic. `channel:manage`.
 *
 * `type` is deliberately not updatable. Flipping a channel public→private has to
 * evict every non-member's open socket, and private→public exposes history
 * written under an expectation of privacy — both are real features with real
 * decisions behind them (§3.3 names `channel.visibility_changed` for exactly
 * this), and neither is a field on an edit form. The event for it is not
 * registered either, so this is one decision recorded in two places rather than
 * a gap.
 */
export async function updateChannel(
  actor: ChatActor,
  input: {
    readonly channelId: ChannelId;
    readonly name: string;
    readonly topic: string | null;
  },
): Promise<{ readonly updated: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:manage', channel);

    if (channel.archivedAt !== null) {
      throw errors.validation({ channelId: 'An archived channel cannot be edited.' });
    }

    /* A DM has no name to change, and `channels_name_matches_type` would refuse
       the write anyway — answered here so the caller gets a reason rather than a
       constraint violation surfacing as INTERNAL_ERROR. */
    if (channel.name === null) {
      throw errors.validation({ channelId: 'A direct message cannot be renamed.' });
    }

    const before = { name: channel.name, topic: channel.topic };
    const after = { name: input.name, topic: input.topic };

    if (before.name === after.name && before.topic === after.topic) {
      /* No write, no event. An event claiming an update that changed nothing
         puts a meaningless entry in the compliance record and wakes every
         consumer for it. */
      return { updated: false };
    }

    try {
      await tx
        .update(schema.channels)
        .set({ name: after.name, topic: after.topic, updatedAt: new Date() })
        .where(eq(schema.channels.id, input.channelId));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.validation({ name: 'A channel with this name already exists.' });
      }
      throw error;
    }

    await outboxWriter.append(tx, [
      createEvent(channelUpdated, { channelId: input.channelId, before, after }, envelopeOf(actor)),
    ]);

    return { updated: true };
  });
}

/**
 * Archives or restores a channel. `channel:manage`.
 *
 * A DM cannot be archived — there is nobody holding `channel:manage` on one, so
 * this refuses through the ordinary authorization path rather than a special
 * case. Worth knowing when reading a failing test: the denial comes from
 * `can()`, not from a branch here.
 */
export async function archiveChannel(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly restored: boolean },
): Promise<{ readonly archived: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:manage', channel);

    const alreadyInState = input.restored
      ? channel.archivedAt === null
      : channel.archivedAt !== null;
    if (alreadyInState) return { archived: !input.restored };

    await tx
      .update(schema.channels)
      .set({ archivedAt: input.restored ? null : new Date(), updatedAt: new Date() })
      .where(eq(schema.channels.id, input.channelId));

    await outboxWriter.append(tx, [
      createEvent(
        channelArchived,
        { channelId: input.channelId, name: channel.name, restored: input.restored },
        envelopeOf(actor),
      ),
    ]);

    return { archived: !input.restored };
  });
}

/* -------------------------------------------------------------------------- *
 * Membership
 * -------------------------------------------------------------------------- */

/**
 * Adds someone to a channel — or joins a public one.
 *
 * The permission depends on who is being added, and the split is the same shape
 * as comment deletion's author-or-moderator test. Joining a PUBLIC channel
 * yourself needs only `channel:read`, which every member holds: a public channel
 * is already readable, so requiring `channel:manage` to join one would mean
 * anyone could read it and nobody could subscribe to it. Adding somebody ELSE,
 * or joining anything closed, is `channel:manage`.
 */
export async function addChannelMember(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly userId: UserId },
): Promise<{ readonly added: boolean }> {
  const self = userOf(actor);

  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);

    const selfJoiningOpenChannel = input.userId === self && !isClosedChannel(channel);
    enforceOnChannel(actor, selfJoiningOpenChannel ? 'channel:read' : 'channel:manage', channel);

    if (channel.archivedAt !== null) {
      throw errors.validation({ channelId: 'An archived channel cannot take new members.' });
    }

    /* A DM's participants are fixed at creation. Adding a third person to a
       two-person conversation would silently expose its entire history to
       someone who was not part of it — the group DM they wanted is a NEW
       channel, which is what `openDirectMessage` produces for a larger set. */
    if (channel.type === 'dm' || channel.type === 'group_dm') {
      throw errors.validation({ channelId: 'A direct message has fixed participants.' });
    }

    /* Idempotent: adding an existing member is a no-op, not an error. The unique
       index on the tuple would refuse the second row anyway; answering cleanly
       here keeps a double-click from surfacing a constraint violation. */
    if (await isChannelMember(tx, input.channelId, input.userId)) {
      return { added: false };
    }

    const target = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.userId, input.userId), eq(schema.memberships.status, 'active')),
      )
      .limit(1);

    /* Not a member of this org. NOT_FOUND rather than a validation error: to the
       caller, a user id from another tenant and a made-up one are the same
       thing, and distinguishing them makes this route an existence oracle for
       accounts. */
    if (target.length === 0) throw errors.notFound();

    await addChannelMemberTuple(tx, {
      orgId: orgOf(actor),
      channelId: input.channelId,
      userId: input.userId,
      grantedBy: self,
    });

    await outboxWriter.append(tx, [
      createEvent(
        channelMemberAdded,
        { channelId: input.channelId, userId: input.userId, addedBy: self },
        envelopeOf(actor),
      ),
    ]);

    return { added: true };
  });
}

/**
 * Removes someone from a channel, or leaves it.
 *
 * Leaving is always permitted — `channel:read` is enough to give up your own
 * access, and a permission model where you need someone's approval to stop
 * reading a channel would be absurd. Removing someone else is `channel:manage`.
 *
 * The `member` tuple deletion is what makes this take effect on a LIVE
 * connection: the `grant.revoked` path in the gateway re-runs room
 * authorization, and the removed person's open tab is force-left within a relay
 * tick rather than continuing to receive every message in a channel they were
 * just removed from.
 */
export async function removeChannelMember(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly userId: UserId },
): Promise<{ readonly removed: boolean }> {
  const self = userOf(actor);
  const voluntary = input.userId === self;

  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, voluntary ? 'channel:read' : 'channel:manage', channel);

    /* A DM's participants are fixed for the same reason they cannot be added to:
       a conversation one side has left is not a conversation, and the remaining
       participant would be posting into a channel with an audience of nobody
       while it still looked live. */
    if (channel.type === 'dm' || channel.type === 'group_dm') {
      throw errors.validation({ channelId: 'A direct message has fixed participants.' });
    }

    const removed = await removeChannelMemberTuple(tx, {
      channelId: input.channelId,
      userId: input.userId,
    });

    /* Not a member: no write, and therefore no event. Emitting one anyway would
       tell the gateway to force-leave a socket over a change that did not
       happen, and put a removal in the audit log for someone who was never
       there. */
    if (!removed) return { removed: false };

    await outboxWriter.append(tx, [
      createEvent(
        channelMemberRemoved,
        { channelId: input.channelId, userId: input.userId, voluntary },
        envelopeOf(actor),
      ),
    ]);

    return { removed: true };
  });
}

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

type ChatTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * The existing DM channel whose member set is exactly `participants`, or null.
 *
 * Candidates come from the CALLER's own tuples: a conversation they are not in
 * is not the conversation being reopened, so there is no need to look at the
 * org's other channels. That is what keeps this bounded no matter how many DMs
 * the organization holds.
 */
async function findDirectMessage(
  tx: ChatTx,
  actor: ChatActor,
  participants: readonly string[],
): Promise<ChannelId | null> {
  const candidateIds = actor.subject.tuples
    .filter((tuple) => tuple.object.type === 'channel')
    .map((tuple) => tuple.object.id);

  if (candidateIds.length === 0) return null;

  const rows = await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(
        inArray(schema.channels.id, candidateIds),
        inArray(schema.channels.type, ['dm', 'group_dm']),
        isNull(schema.channels.archivedAt),
      ),
    );

  if (rows.length === 0) return null;

  const membersByChannel = await membersOfChannels(
    tx,
    rows.map((row) => row.id),
  );

  const wanted = new Set(participants);

  for (const row of rows) {
    const members = membersByChannel.get(row.id);
    if (members === undefined) continue;
    /* Set EQUALITY, both directions. A subset test would match the two-person DM
       when opening a three-person group, and hand a private conversation a third
       participant it never had. */
    if (members.size !== wanted.size) continue;
    if ([...wanted].every((userId) => members.has(userId))) {
      return row.id as ChannelId;
    }
  }

  return null;
}

/** SQLSTATE for a unique constraint violation — see work/shared.ts. */
function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
