import { createEvent } from '@taskflow/events';
import { channelArchived, channelCreated, channelMemberAdded } from '@taskflow/api/events/chat';
import { roleGrants, type Relation, type ResourceType } from '@taskflow/policy';
import type { schema } from '@taskflow/db';
import { channelTopic } from '../corpus.js';
import type { Rng } from '../rng.js';
import type { ChannelPlan } from '../profiles.js';
import { defineSeedModule } from '../registry.js';
import { daysBefore, envelopeFor, latest } from '../support.js';
import { orgsModule, type SeededMembership, type SeededOrg } from './tenancy.orgs.js';

/**
 * Channels, and the tuples that are their membership.
 *
 * ## There is no roster table to write
 *
 * The surprising half of this module is that half of it writes to
 * `authz.relationship_tuples`. Migration 0017 argues at length that channel
 * membership is a relation tuple — (user, 'member', channel:{id}) — and not a
 * `chat.channel_members` table, because `can()` already reads tuples, Phase 4's
 * revocation path already force-leaves sockets when one changes, and the
 * `member` relation was written in Phase 2 for exactly this. So a seeded channel
 * is one row here and one tuple per person, and a channel seeded WITHOUT its
 * tuples is not a channel with an empty roster: it is a private channel nobody,
 * including its creator, can open.
 *
 * ## Joined is not the same as readable
 *
 * A tuple on a PUBLIC channel does not grant anything the org role did not
 * already grant — `member` holds `channel:read` and public channels are open
 * (`isClosedChannel` in `chat/shared.ts`). What it does is make the channel
 * appear as JOINED: `listChannels` derives that flag from the caller's own
 * tuples. So the rosters below are "who opted in", and a public channel whose
 * roster is a subset of the org is the ordinary case rather than a mistake.
 *
 * On a private channel, a DM or a group DM the same tuple is the entire
 * authorization. That asymmetry is the reason `channelTarget` exists and the
 * reason this module never invents a roster for a closed channel.
 *
 * ## Roles are asked, never compared
 *
 * Every "who could plausibly have done this" question here goes through
 * `roleGrants` from `@taskflow/policy` — guardrail 7 bans `role === ...`
 * outside that package, and the answer is to move the decision where the policy
 * matrix test can see it. It also keeps the fixture honest: a channel created by
 * someone who does not hold `channel:create` is a row the product could not have
 * produced, and the guest below is identified by holding NO channel access from
 * their role rather than by being spelled 'guest'.
 */

/* Typed against `@taskflow/policy`'s own unions rather than written as bare
   strings. A typo in either would write a tuple that grants nothing and is
   invisible in every decision trace — `loadTuples` drops unrecognized relations
   before the engine sees them, so the row exists, looks right in the table, and
   does nothing. Annotated here, it fails to compile instead. Same reasoning as
   `CHANNEL_MEMBER_RELATION` in `apps/api/src/chat/membership.ts`. */
const CHANNEL_MEMBER_RELATION: Relation = 'member';
const CHANNEL_OBJECT_TYPE: ResourceType = 'channel';

export interface SeededChannel {
  readonly id: string;
  readonly orgId: string;
  /** Carried by reference so `chat.messages` reaches the org, its members and
   * their roles without re-requiring `tenancy.orgs` — the same arrangement
   * `SeededBoard` makes for its project. */
  readonly org: SeededOrg;
  readonly type: schema.ChannelType;
  readonly name: string | null;
  readonly plan: ChannelPlan;
  /** The roster, roles included. Message authors are drawn from exactly this. */
  readonly members: readonly SeededMembership[];
  readonly creator: SeededMembership;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export interface ChannelsOutput {
  readonly channels: readonly SeededChannel[];
}

/** True for a direct message of either size — the two share every rule but arity. */
function isDirect(type: schema.ChannelType): boolean {
  return type === 'dm' || type === 'group_dm';
}

/**
 * Someone whose ROLE reaches no channel at all — the guest.
 *
 * Asked as a capability rather than by name. `guest` grants nothing
 * (`packages/policy/src/roles.ts` makes an empty list the whole point), so
 * "cannot read a channel through their role" identifies exactly the person whose
 * access has to arrive as a tuple. Written this way round so that a future role
 * with the same property is picked up rather than missed.
 */
function reachesNoChannelByRole(membership: SeededMembership): boolean {
  return !roleGrants(membership.role, 'channel:read');
}

export const channelsModule = defineSeedModule({
  name: 'chat.channels',
  requires: [orgsModule],
  tables: ['chat.channels', 'authz.relationship_tuples'],

  async seed(ctx): Promise<ChannelsOutput> {
    const rng = ctx.rng.fork('chat.channels');
    const { orgs } = ctx.use(orgsModule);
    const channels: SeededChannel[] = [];

    for (const org of orgs) {
      if (org.plan.channels.length === 0) continue;

      const channelRows: unknown[][] = [];
      const tupleRows: unknown[][] = [];

      /* Participant sets already used for a direct message in this org. Two
         DMs between the same people split a conversation in half with no way
         to merge it and no error anywhere — `openDirectMessage` deduplicates
         for that reason, and there is no unique index that could, because the
         participant set is not a column. */
      const directSets = new Set<string>();
      const liveNames = new Set<string>();

      for (const plan of org.plan.channels) {
        const roster = buildRoster(rng, org, plan, directSets);
        if (roster === null) continue;

        const channelId = rng.uuid(ctx.now);
        const createdAt = latest(org.createdAt, daysBefore(ctx.now, rng.int(20, 260)));
        const archivedAt = plan.archived
          ? latest(createdAt, daysBefore(ctx.now, rng.int(2, 18)))
          : null;

        /* `channels_org_name_key` is unique on (org_id, lower(name)) for LIVE
           named channels. Checked here rather than left to Postgres because the
           constraint violation would name an index, not the profile entry that
           asked for a second #general. */
        if (plan.name !== null && archivedAt === null) {
          const key = plan.name.toLowerCase();
          if (liveNames.has(key)) {
            throw new Error(
              `chat.channels: org "${org.slug}" plans two live channels named "${plan.name}". ` +
                'Names are unique per org, case-insensitively — rename one in profiles.ts.',
            );
          }
          liveNames.add(key);
        }

        const topic = plan.topic === true && !isDirect(plan.type) ? channelTopic(rng) : null;

        channelRows.push([
          channelId,
          org.id,
          plan.type,
          /* Null for a DM, and `channels_name_matches_type` is what enforces it.
             The plan carries the null rather than this module deriving one, so
             the refused state is unrepresentable a step earlier. */
          plan.name,
          topic,
          roster.creator.user.id,
          archivedAt,
          createdAt,
          archivedAt ?? createdAt,
        ]);

        /* Nobody "added" anyone to a DM — they are its participants. Recording
           the opener as the granter would read, in an access review, as one
           person having granted another access to a private conversation.
           `openDirectMessage` writes null for the same reason. */
        const grantedBy = isDirect(plan.type) ? null : roster.creator.user.id;

        for (const membership of roster.members) {
          tupleRows.push([
            rng.uuid(ctx.now),
            org.id,
            'user',
            membership.user.id,
            CHANNEL_MEMBER_RELATION,
            CHANNEL_OBJECT_TYPE,
            channelId,
            grantedBy,
            /* No expiry. Wave 4's guest access is what `expires_at` is for, and
               a seeded tuple that expired between two runs would make the guest
               case reproduce differently on different days. */
            null,
            createdAt,
          ]);
        }

        const envelope = envelopeFor(org.id, roster.creator.user.id, createdAt);

        /* Structural events, always emitted rather than sampled — the same rule
           `tenancy.orgs` states. "Who is in this private channel, and who put
           them there" is the first question of any access review. */
        ctx.emit(
          createEvent(
            channelCreated,
            {
              channelId,
              type: plan.type,
              name: plan.name,
              memberCount: roster.members.length,
            },
            envelope,
          ),
        );

        for (const membership of roster.members) {
          ctx.emit(
            createEvent(
              channelMemberAdded,
              { channelId, userId: membership.user.id, addedBy: grantedBy },
              envelope,
            ),
          );
        }

        if (archivedAt !== null) {
          ctx.emit(
            createEvent(
              channelArchived,
              { channelId, name: plan.name, restored: false },
              envelopeFor(org.id, roster.creator.user.id, archivedAt),
            ),
          );
        }

        channels.push({
          id: channelId,
          orgId: org.id,
          org,
          type: plan.type,
          name: plan.name,
          plan,
          members: roster.members,
          creator: roster.creator,
          createdAt,
          archivedAt,
        });
      }

      await ctx.orgScope(org.id, async () => {
        await ctx.db.insert(
          'chat.channels',
          [
            'id',
            'org_id',
            'type',
            'name',
            'topic',
            'created_by',
            'archived_at',
            'created_at',
            'updated_at',
          ],
          channelRows,
        );

        await ctx.db.insert(
          'authz.relationship_tuples',
          [
            'id',
            'org_id',
            'subject_type',
            'subject_id',
            'relation',
            'object_type',
            'object_id',
            'granted_by',
            'expires_at',
            'created_at',
          ],
          tupleRows,
        );
      });

      ctx.log(
        `chat.channels: ${org.slug} — ${String(channelRows.length)} channels, ` +
          `${String(tupleRows.length)} memberships`,
      );
    }

    return { channels };
  },
});

interface Roster {
  readonly creator: SeededMembership;
  readonly members: readonly SeededMembership[];
}

/**
 * Who is in a channel, and who created it.
 *
 * Returns null only for a direct message whose participant set is already taken
 * — that one is skipped rather than fatal, because it is a collision in a random
 * draw and not a mistake in the profile. Every other impossibility (a plan
 * asking for more members than the org has, a DM with three participants, an org
 * with nobody able to create a channel) throws, because each of those is a
 * profile that cannot be satisfied and silently shrinking it would produce a
 * database that does not match what was asked for.
 */
function buildRoster(
  rng: Rng,
  org: SeededOrg,
  plan: ChannelPlan,
  directSets: Set<string>,
): Roster | null {
  if (plan.members > org.memberships.length) {
    throw new Error(
      `chat.channels: org "${org.slug}" has ${String(org.memberships.length)} members but a ` +
        `channel plan asks for ${String(plan.members)}. Lower \`members\` in profiles.ts.`,
    );
  }

  if (isDirect(plan.type)) {
    return directRoster(rng, org, plan, directSets);
  }

  /* Guests are kept out of every roster except the one that names them. A guest
     holding a tuple on a public channel is a perfectly legal state, but seeding
     it by accident would blunt the case this fixture exists to make: signing in
     as the guest must reach exactly one channel. */
  const wantsGuest = plan.withGuest === true;
  const guest = wantsGuest ? org.memberships.find(reachesNoChannelByRole) : undefined;
  if (wantsGuest && !guest) {
    throw new Error(
      `chat.channels: channel "${plan.name ?? 'dm'}" in "${org.slug}" asks for a guest, but no ` +
        'member of that org holds a role granting no channel access. Add a guest to the org plan.',
    );
  }

  /* Someone who could actually have created it. `member` does not hold
     `channel:create` — a channel whose `created_by` is a member is a row no
     route could have written. */
  const founders = org.memberships.filter((membership) =>
    roleGrants(membership.role, 'channel:create'),
  );
  const creator = founders[0] === undefined ? undefined : rng.pick(founders);
  if (!creator) {
    throw new Error(
      `chat.channels: org "${org.slug}" has nobody holding channel:create, so its channels ` +
        'could not have been created by anyone in it. Give the org an owner or an admin.',
    );
  }

  const members: SeededMembership[] = [creator];
  const taken = new Set<string>([creator.user.id]);

  if (guest && !taken.has(guest.user.id)) {
    members.push(guest);
    taken.add(guest.user.id);
  }

  const pool = org.memberships.filter(
    (membership) => !taken.has(membership.user.id) && !reachesNoChannelByRole(membership),
  );

  for (const membership of rng.sample(pool, Math.max(0, plan.members - members.length))) {
    members.push(membership);
  }

  return { creator, members };
}

/**
 * The participants of a direct message.
 *
 * `created_by` is simply the first participant: opening a DM needs no
 * `channel:create` (`openDirectMessage` enforces none), because a conversation
 * between two people is not a channel anyone is creating FOR anyone.
 */
function directRoster(
  rng: Rng,
  org: SeededOrg,
  plan: ChannelPlan,
  directSets: Set<string>,
): Roster | null {
  const wanted = plan.type === 'dm' ? 2 : plan.members;

  if (plan.type === 'dm' && plan.members !== 2) {
    throw new Error(
      `chat.channels: a 'dm' has exactly two participants; "${org.slug}" plans ` +
        `${String(plan.members)}. Use 'group_dm' for three or more.`,
    );
  }
  if (plan.type === 'group_dm' && plan.members < 3) {
    throw new Error(
      `chat.channels: a 'group_dm' needs at least three participants; "${org.slug}" plans ` +
        `${String(plan.members)}. Use 'dm' for two.`,
    );
  }

  /* Guests are excluded here as well. A guest in a DM would be reachable chat
     that the "exactly one channel" case does not account for. */
  const pool = org.memberships.filter((membership) => !reachesNoChannelByRole(membership));
  if (pool.length < wanted) {
    throw new Error(
      `chat.channels: org "${org.slug}" has ${String(pool.length)} non-guest members, too few ` +
        `for a ${plan.type} of ${String(wanted)}. Remove the plan or add members.`,
    );
  }

  /* Bounded rather than unconditional — the same discipline `authz.tuples` and
     `people()` use. A profile asking for more distinct conversations than the
     org can hold should say so rather than spin. */
  const maxAttempts = 40;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const participants = rng.sample(pool, wanted);
    const key = participants
      .map((membership) => membership.user.id)
      .sort()
      .join('|');
    if (directSets.has(key)) continue;
    directSets.add(key);

    const creator = participants[0];
    if (!creator) continue;
    return { creator, members: participants };
  }

  /* Every draw collided. Skipped rather than fatal: this is a random collision
     in a finite space, not a profile that cannot be satisfied, and one fewer DM
     is a smaller lie than two conversations between the same two people. */
  return null;
}
