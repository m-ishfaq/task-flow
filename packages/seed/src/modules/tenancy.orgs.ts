import { createEvent } from '@taskflow/events';
import {
  memberAdded,
  orgCreated,
  teamCreated,
  teamMemberAdded,
} from '@taskflow/api/events/tenancy';
import { isIndispensableRole, type Role } from '@taskflow/policy';
import { defineSeedModule } from '../registry.js';
import { daysBefore, envelopeFor, slugify } from '../support.js';
import { usersModule, type SeededUser } from './identity.users.js';
import type { OrgPlan } from '../profiles.js';

/**
 * Organizations, memberships and teams — the tenant boundary itself.
 *
 * Two things here are the point of the whole module rather than incidental:
 *
 * **`identity.orgs` is scoped by `id`, not `org_id`.** The tenant IS the row,
 * so its RLS policy names the column explicitly. In practice that means the org
 * row has to be inserted with `app.org_id` already set to the id being
 * inserted — an ordering that reads like a chicken-and-egg problem and is not
 * one, because the id is generated here before either statement runs. Exactly
 * how `createOrg` does it in the org service, and for exactly the same reason:
 * there is no privileged path that creates a tenant from outside.
 *
 * **A user in two orgs is seeded on purpose.** See `OrgPlan.members` — the org
 * switcher, `OrgGate`'s validation of the stored org, and the NOT_A_MEMBER
 * recovery are all unreachable with single-org users, and CLAUDE.md records all
 * three as places a bug hid for a long time.
 */

export interface SeededMembership {
  readonly membershipId: string;
  readonly user: SeededUser;
  readonly role: Role;
}

export interface SeededTeam {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly members: readonly SeededUser[];
}

export interface SeededOrg {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly plan: OrgPlan;
  readonly owner: SeededUser;
  readonly memberships: readonly SeededMembership[];
  readonly teams: readonly SeededTeam[];
  /** Everyone in the org, in plan order. The assignee and author pool. */
  readonly members: readonly SeededUser[];
  /** When the org was created. Nothing inside it may predate this. */
  readonly createdAt: Date;
}

export interface OrgsOutput {
  readonly orgs: readonly SeededOrg[];
}

export const orgsModule = defineSeedModule({
  name: 'tenancy.orgs',
  requires: [usersModule],
  tables: ['identity.orgs', 'identity.memberships', 'identity.teams', 'identity.team_members'],

  async seed(ctx): Promise<OrgsOutput> {
    const rng = ctx.rng.fork('tenancy.orgs');
    const { users } = ctx.use(usersModule);
    const orgs: SeededOrg[] = [];

    for (const plan of ctx.profile.orgs) {
      const orgId = rng.uuid(ctx.now);
      const createdAt = daysBefore(ctx.now, rng.int(200, 400));

      const memberships: SeededMembership[] = plan.members.map((entry) => {
        const user = users[entry.user];
        if (!user) {
          throw new Error(
            `Profile "${ctx.profile.name}" puts user index ${String(entry.user)} in ` +
              `"${plan.slug}", but the pool holds ${String(users.length)} users. ` +
              'Raise `users` on the profile or lower the index.',
          );
        }
        return { membershipId: rng.uuid(ctx.now), user, role: entry.role };
      });

      const owner = memberships.find((membership) => isIndispensableRole(membership.role))?.user;
      if (!owner) {
        throw new Error(`Org "${plan.slug}" has no owner. Every org needs exactly one.`);
      }

      const members = memberships.map((membership) => membership.user);

      const teams: SeededTeam[] = plan.teams.map((name) => ({
        id: rng.uuid(ctx.now),
        name,
        slug: slugify(name),
        // Teams draw from the org's own members — a team member who is not an
        // org member is refused by `team_members`' composite key, and is
        // meaningless anyway.
        members: rng.sample(members, Math.min(members.length, rng.int(2, 6))),
      }));

      /* Everything below is inside this org's scope. `identity.orgs` included:
         its policy compares `id` against app.org_id, so the INSERT writes zero
         rows without this — and reports success. */
      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'identity.orgs',
          ['id', 'name', 'slug', 'status', 'created_at', 'updated_at'],
          /* `OrgPlan.status` — a suspended org is written suspended, not
             created active and suspended afterwards. See the field's comment
             in profiles.ts: a seed has no EventBus to emit
             `platform.org_suspended` through, so the row is the durable
             record, and everything this module seeds beneath it (members,
             teams, projects, channels, spaces) still lands — the operator
             console lists a suspended org's directory, which is the whole
             point of seeding one. */
          [[orgId, plan.name, plan.slug, plan.status ?? 'active', createdAt, createdAt]],
        );

        await ctx.db.insert(
          'identity.memberships',
          [
            'id',
            'org_id',
            'user_id',
            'role',
            'status',
            'invited_by',
            'joined_at',
            'created_at',
            'updated_at',
          ],
          memberships.map((membership) => {
            const joinedAt = daysBefore(ctx.now, rng.int(10, 190));
            const joined = joinedAt.getTime() < createdAt.getTime() ? createdAt : joinedAt;
            return [
              membership.membershipId,
              orgId,
              membership.user.id,
              membership.role,
              'active',
              // Null for the founding owner, who was invited by nobody. A real
              // value rather than a missing one — see the column comment.
              isIndispensableRole(membership.role) ? null : owner.id,
              joined,
              joined,
              joined,
            ];
          }),
        );

        if (teams.length > 0) {
          await ctx.db.insert(
            'identity.teams',
            ['id', 'org_id', 'name', 'slug', 'created_at', 'updated_at'],
            teams.map((team) => [team.id, orgId, team.name, team.slug, createdAt, createdAt]),
          );

          const teamMemberRows = teams.flatMap((team) =>
            team.members.map((member) => [orgId, team.id, member.id, createdAt]),
          );
          await ctx.db.insert(
            'identity.team_members',
            ['org_id', 'team_id', 'user_id', 'added_at'],
            teamMemberRows,
          );
        }
      });

      /* Events. Structural rows are always emitted rather than sampled: "who
         made this person an admin, and when" is the first question of any
         incident, and it is the one thing the audit log exists to answer. */
      const envelope = envelopeFor(orgId, owner.id, createdAt);

      ctx.emit(
        createEvent(
          orgCreated,
          { orgId, name: plan.name, slug: plan.slug, ownerId: owner.id },
          envelope,
        ),
      );

      for (const membership of memberships) {
        ctx.emit(
          createEvent(
            memberAdded,
            {
              membershipId: membership.membershipId,
              userId: membership.user.id,
              email: membership.user.email,
              role: membership.role,
              invitedBy: isIndispensableRole(membership.role) ? null : owner.id,
            },
            envelope,
          ),
        );
      }

      for (const team of teams) {
        ctx.emit(
          createEvent(teamCreated, { teamId: team.id, name: team.name, slug: team.slug }, envelope),
        );
        for (const member of team.members) {
          ctx.emit(createEvent(teamMemberAdded, { teamId: team.id, userId: member.id }, envelope));
        }
      }

      orgs.push({
        id: orgId,
        name: plan.name,
        slug: plan.slug,
        plan,
        owner,
        memberships,
        teams,
        members,
        createdAt,
      });

      ctx.log(
        `tenancy.orgs: ${plan.slug} — ${String(memberships.length)} members, ` +
          `${String(teams.length)} teams`,
      );
    }

    return { orgs };
  },
});
