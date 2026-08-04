import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId, type TeamId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { teamCreated, teamMemberAdded, teamMemberRemoved } from './events.js';
import type { Actor } from './org.service.js';

/**
 * Teams (PLAN.md §3.5, §8.2).
 *
 * A team matters to authorization because a relationship tuple may name one as
 * its subject — "the platform team owns this project" — which the loader
 * expands into per-user tuples before the policy engine sees them. That is what
 * keeps "add someone to a team" from needing to touch every grant that team
 * holds.
 *
 * The consequence worth knowing: adding a member to a team grants them
 * everything that team has been granted, immediately, with no further action.
 * So team membership is itself an authorization change, and every mutation here
 * emits an event for the audit log.
 */

export interface TeamMemberSummary {
  readonly userId: string;
  readonly email: string;
}

export interface TeamSummary {
  readonly teamId: string;
  readonly name: string;
  readonly slug: string;
  /** The roster itself. `memberCount` would be `members.length` — see below. */
  readonly members: readonly TeamMemberSummary[];
}

/**
 * Every team in the organization, each with its roster.
 *
 * ## Why the roster and not a count
 *
 * This used to return `memberCount`, and the settings page could therefore show
 * how many people were on a team but never WHICH — so removing someone meant
 * picking from a dropdown of every member in the org, including the ones who
 * were not on the team, and the only feedback was the count changing (or not).
 *
 * The count was never cheaper. Computing it already required reading every
 * `team_members` row, so the roster costs exactly one join to `users` for the
 * addresses, over a table bounded by team membership rather than by anything
 * unbounded.
 *
 * No new exposure either: `team:read` and `member:read` are held by the same
 * roles, and `members.list` already returns every address in the org. A caller
 * who can reach this route can already enumerate the same people.
 */
export async function listTeams(orgId: OrgId): Promise<readonly TeamSummary[]> {
  return withOrgScope(orgId, async (tx) => {
    const teams = await tx
      .select({ teamId: schema.teams.id, name: schema.teams.name, slug: schema.teams.slug })
      .from(schema.teams)
      .orderBy(schema.teams.name);

    /* No `org_id` in the WHERE clause — RLS enforces it (guardrail 2). The join
       is to users, which is NOT tenant-scoped, so it is reached only through
       team_members rows this org can already see. */
    const members = await tx
      .select({
        teamId: schema.teamMembers.teamId,
        userId: schema.teamMembers.userId,
        email: schema.users.email,
      })
      .from(schema.teamMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
      .orderBy(schema.users.email);

    const rosters = new Map<string, TeamMemberSummary[]>();
    for (const row of members) {
      const roster = rosters.get(row.teamId) ?? [];
      roster.push({ userId: row.userId, email: row.email });
      rosters.set(row.teamId, roster);
    }

    return teams.map((team) => ({ ...team, members: rosters.get(team.teamId) ?? [] }));
  });
}

export async function createTeam(
  orgId: OrgId,
  input: { readonly name: string; readonly slug: string },
  actor: Actor,
): Promise<{ readonly teamId: TeamId }> {
  const teamId = newId<'TeamId'>();

  return withOrgScope(orgId, async (tx) => {
    const clash = await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.slug, input.slug))
      .limit(1);

    if (clash[0]) throw errors.conflict('A team with that address already exists.');

    await tx.insert(schema.teams).values({ id: teamId, orgId, name: input.name, slug: input.slug });

    await outboxWriter.append(tx, [
      createEvent(
        teamCreated,
        { teamId, name: input.name, slug: input.slug },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { teamId };
  });
}

/**
 * Adds a member to a team.
 *
 * The membership check is not a convenience. Without it a user from outside the
 * org could be placed on a team and would then inherit every grant that team
 * holds — an access path that no membership row records and that
 * `listMembers` would never show.
 */
export async function addTeamMember(
  orgId: OrgId,
  input: { readonly teamId: TeamId; readonly userId: UserId },
  actor: Actor,
): Promise<{ readonly added: true }> {
  return withOrgScope(orgId, async (tx) => {
    const team = await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .limit(1);

    if (!team[0]) throw errors.notFound();

    const membership = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.userId, input.userId), eq(schema.memberships.status, 'active')),
      )
      .limit(1);

    if (!membership[0]) throw errors.notFound();

    const already = await tx
      .select({ userId: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, input.teamId),
          eq(schema.teamMembers.userId, input.userId),
        ),
      )
      .limit(1);

    if (already[0]) return { added: true as const };

    await tx
      .insert(schema.teamMembers)
      .values({ orgId, teamId: input.teamId, userId: input.userId });

    await outboxWriter.append(tx, [
      createEvent(
        teamMemberAdded,
        { teamId: input.teamId, userId: input.userId },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { added: true as const };
  });
}

export async function removeTeamMember(
  orgId: OrgId,
  input: { readonly teamId: TeamId; readonly userId: UserId },
  actor: Actor,
): Promise<{ readonly removed: true }> {
  return withOrgScope(orgId, async (tx) => {
    const result = await tx
      .delete(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, input.teamId),
          eq(schema.teamMembers.userId, input.userId),
        ),
      );

    // Nothing removed means the team is not this org's, or the user was never
    // on it. Both answer 404 — distinguishing them across tenants would confirm
    // a team id belonging to someone else.
    if (result.rowCount === 0) throw errors.notFound();

    await outboxWriter.append(tx, [
      createEvent(
        teamMemberRemoved,
        { teamId: input.teamId, userId: input.userId },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { removed: true as const };
  });
}
