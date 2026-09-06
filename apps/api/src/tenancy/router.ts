import { z } from 'zod';
import { OrgIdSchema, TeamIdSchema, UserIdSchema } from '@taskflow/contracts';
import { route, router, selfRoute } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { Actor } from './org.service.js';
import * as orgs from './org.service.js';
import * as members from './member.service.js';
import * as teams from './team.service.js';
import * as grants from './grant.service.js';
import * as memberGrants from './member-grant.service.js';
import * as authz from './authz.service.js';
import * as audit from './audit.service.js';

/**
 * Tenancy, authorization and audit routes (PLAN.md §13 phase 2).
 *
 * Every route here is permission-bearing except `orgs.create` and `orgs.list`.
 * Those two are `selfRoute`, and the reason is worth stating plainly because it
 * looks like a gap in guardrail 4: a caller who is not yet in ANY organization
 * has no role, so no org permission can describe what they are allowed to do.
 * Requiring one would make it impossible to create a first organization, and
 * inventing an `org:create` permission would be a permission that every role
 * holds — which is a permission that means nothing.
 *
 * What bounds them instead: `orgs.list` returns only the caller's own
 * memberships, enforced by RLS rather than by a WHERE clause, and `orgs.create`
 * makes the caller the owner of a brand-new tenant containing nothing. Neither
 * can reach another tenant's data.
 */

const Slug = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/, 'Use lowercase letters, numbers and hyphens.');

const Name = z.string().trim().min(1).max(120);
const Role = z.enum(['owner', 'admin', 'member', 'guest']);

export interface TenancyRouterDeps {
  /** Phase 12 Wave 3 §3.4 — how long a newly created org's trial runs. */
  readonly trialDays: number;
}

export function createTenancyRouter(deps: TenancyRouterDeps) {
  const actorOf = (ctx: {
    principal: { userId: Actor['userId'] };
    requestId: Actor['requestId'];
  }): Actor => ({ userId: ctx.principal.userId, requestId: ctx.requestId });

  return router({
    orgs: router({
      create: selfRoute({
        selfReason:
          'Creating a first organization cannot require membership of one. The caller becomes its owner and it contains nothing else.',
      })
        .input(z.object({ name: Name, slug: Slug }).strict())
        .output(z.object({ orgId: z.string(), slug: z.string() }))
        .mutation(({ input, ctx }) =>
          orgs.createOrg(input, actorOf(ctx), { trialDays: deps.trialDays }),
        ),

      list: selfRoute({
        selfReason:
          'The organization switcher. Spans orgs by definition, so no org permission applies; RLS limits it to the caller’s own memberships.',
      })
        .output(
          z
            .array(
              z.object({
                orgId: z.string(),
                name: z.string(),
                slug: z.string(),
                role: z.string(),
              }),
            )
            .readonly(),
        )
        .query(({ ctx }) => orgs.listMyOrgs(ctx.principal.userId)),

      get: route({ permission: 'org:read' })
        .output(
          z.object({
            orgId: z.string(),
            name: z.string(),
            slug: z.string(),
            createdAt: z.date(),
            /* Read by the Settings page so a control an unusable route
               backs does not render, the same shape chat's channel
               `capabilities` uses. */
            capabilities: z
              .object({
                updateOrg: z.boolean(),
                inviteMember: z.boolean(),
                manageMembers: z.boolean(),
                removeMembers: z.boolean(),
                manageTeams: z.boolean(),
                createProject: z.boolean(),
                viewAnalytics: z.boolean(),
                viewAuditLog: z.boolean(),
                readPhoneNumbers: z.boolean(),
                placeCalls: z.boolean(),
                readCalls: z.boolean(),
                sendSms: z.boolean(),
                readSms: z.boolean(),
                manageAutomations: z.boolean(),
                manageWebhooks: z.boolean(),
                manageIntegrations: z.boolean(),
                createApiTokens: z.boolean(),
                revokeApiTokens: z.boolean(),
                viewBilling: z.boolean(),
                purchaseNumbers: z.boolean(),
                releaseNumbers: z.boolean(),
                manageSavedSearches: z.boolean(),
                readRecordings: z.boolean(),
                createSpace: z.boolean(),
                useAi: z.boolean(),
              })
              .strict(),
          }),
        )
        .query(({ ctx }) => orgs.getOrg(ctx.principal.org.orgId, subjectOf(ctx.principal))),

      update: route({ permission: 'org:update' })
        .input(z.object({ name: Name }).strict())
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => orgs.updateOrg(ctx.principal.org.orgId, input, actorOf(ctx))),
    }),

    members: router({
      list: route({ permission: 'member:read' })
        .output(
          z
            .array(
              z.object({
                userId: z.string(),
                email: z.string(),
                displayName: z.string().nullable(),
                role: z.string(),
                status: z.string(),
                joinedAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ ctx }) => members.listMembers(ctx.principal.org.orgId)),

      add: route({ permission: 'member:invite' })
        .input(z.object({ email: z.string().trim().email().max(254), role: Role }).strict())
        .output(z.object({ userId: z.string(), role: z.string() }))
        .mutation(({ input, ctx }) =>
          members.addMember(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),

      /**
       * Step-up authenticated (§8.1).
       *
       * Changing roles is on the step-up list precisely because it is what an
       * attacker holding a stolen session reaches for first — and the window
       * that matters is the ten minutes an access token stays valid.
       */
      changeRole: route({ permission: 'member:manage', stepUp: true })
        .input(z.object({ userId: UserIdSchema, role: Role }).strict())
        .output(z.object({ from: z.string(), to: z.string() }))
        .mutation(({ input, ctx }) =>
          members.changeRole(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),

      remove: route({ permission: 'member:remove', stepUp: true })
        .input(z.object({ userId: UserIdSchema }).strict())
        .output(z.object({ removed: z.literal(true) }))
        .mutation(({ input, ctx }) =>
          members.removeMember(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),

      /**
       * Flags a member as leaving, distinct from `remove` above (§8 of
       * ai/phase-15-ai-copilot-and-permissions.md). Writes nothing to the
       * membership — it exists to give an org's `member.offboarding_started`
       * automation rules something to run against (session revocation, card
       * reassignment, grant cleanup) before the person is actually removed.
       * No step-up: unlike `remove` and `transferOwnership`, nothing here is
       * destructive or hard to undo.
       */
      startOffboarding: route({ permission: 'member:remove' })
        .input(z.object({ userId: UserIdSchema }).strict())
        .output(z.object({ started: z.literal(true) }))
        .mutation(({ input, ctx }) =>
          members.startOffboarding(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),

      /**
       * The single, atomic ownership handoff (Phase 12 Wave 1, §3.5).
       *
       * `member:manage` is Owner-only in the role matrix, so this route is
       * reachable only by whoever holds the role they are giving away.
       * Step-up, like every other role-changing mutation — it is exactly what
       * an attacker with a stolen session reaches for first.
       */
      transferOwnership: route({ permission: 'member:manage', stepUp: true })
        .input(
          z.object({ toUserId: UserIdSchema, selfNewRole: z.enum(['admin', 'member']) }).strict(),
        )
        .output(z.object({ newOwnerId: z.string() }))
        .mutation(({ input, ctx }) =>
          members.transferOwnership(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),
    }),

    teams: router({
      list: route({ permission: 'team:read' })
        .output(
          z
            .array(
              z.object({
                teamId: z.string(),
                name: z.string(),
                slug: z.string(),
                members: z.array(z.object({ userId: z.string(), email: z.string() })).readonly(),
              }),
            )
            .readonly(),
        )
        .query(({ ctx }) => teams.listTeams(ctx.principal.org.orgId)),

      create: route({ permission: 'team:manage' })
        .input(z.object({ name: Name, slug: Slug }).strict())
        .output(z.object({ teamId: z.string() }))
        .mutation(({ input, ctx }) =>
          teams.createTeam(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),

      /**
       * Adding someone to a team grants them everything that team has been
       * granted, immediately — so this is an authorization change, and it is
       * permissioned and audited as one.
       */
      addMember: route({ permission: 'team:manage' })
        .input(z.object({ teamId: TeamIdSchema, userId: UserIdSchema }).strict())
        .output(z.object({ added: z.literal(true) }))
        .mutation(({ input, ctx }) =>
          teams.addTeamMember(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),

      removeMember: route({ permission: 'team:manage' })
        .input(z.object({ teamId: TeamIdSchema, userId: UserIdSchema }).strict())
        .output(z.object({ removed: z.literal(true) }))
        .mutation(({ input, ctx }) =>
          teams.removeTeamMember(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),
    }),

    grants: router({
      list: route({ permission: 'member:read' })
        .input(z.object({ objectType: z.string().max(40), objectId: z.string().uuid() }).strict())
        .output(
          z
            .array(
              z.object({
                tupleId: z.string(),
                subjectType: z.string(),
                subjectId: z.string(),
                relation: z.string(),
                expiresAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => grants.listGrantsOn(ctx.principal.org.orgId, input)),

      /**
       * Writing a tuple is granting access to a specific thing, so it sits
       * behind `member:manage` — Owner-only in the matrix (§8.2). Per-resource
       * sharing by a resource's own owner arrives with the resources
       * themselves, in Phase 3, where a board's owner can share their board
       * without being able to touch anyone's org role.
       */
      grant: route({ permission: 'member:manage', stepUp: true })
        .input(
          z
            .object({
              subjectType: z.enum(['user', 'team']),
              subjectId: z.string().uuid(),
              relation: z.string().max(40),
              objectType: z.string().max(40),
              objectId: z.string().uuid(),
              expiresAt: z.string().datetime().nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ tupleId: z.string() }))
        .mutation(({ input, ctx }) => grants.grant(ctx.principal.org.orgId, input, actorOf(ctx))),

      revoke: route({ permission: 'member:manage', stepUp: true })
        .input(z.object({ tupleId: z.string().uuid() }).strict())
        .output(z.object({ revoked: z.literal(true) }))
        .mutation(({ input, ctx }) => grants.revoke(ctx.principal.org.orgId, input, actorOf(ctx))),
    }),

    /**
     * Individual, org-level permission grants (§1 of
     * ai/phase-15-ai-copilot-and-permissions.md) — distinct from `grants`
     * above, which writes relationship TUPLES on a specific resource. There
     * is no resource here: this is "give this one person `call:place`
     * org-wide", which is exactly the shape `grants` cannot express.
     */
    memberGrants: router({
      list: route({ permission: 'member:read' })
        .output(
          z
            .array(
              z.object({
                grantId: z.string(),
                userId: z.string(),
                permission: z.string(),
                grantedBy: z.string().nullable(),
                grantedAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ ctx }) => memberGrants.listGrants(ctx.principal.org.orgId)),

      /**
       * Step-up authenticated, same as `changeRole` and the tuple `grant`
       * route above — this changes what a specific person may do, which is
       * exactly what an attacker with a stolen session reaches for first.
       */
      grant: route({ permission: 'member:manage', stepUp: true })
        .input(z.object({ userId: UserIdSchema, permission: z.string().max(60) }).strict())
        .output(z.object({ grantId: z.string() }))
        .mutation(({ input, ctx }) =>
          memberGrants.grant(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),

      revoke: route({ permission: 'member:manage', stepUp: true })
        .input(z.object({ userId: UserIdSchema, permission: z.string().max(60) }).strict())
        .output(z.object({ revoked: z.literal(true) }))
        .mutation(({ input, ctx }) =>
          memberGrants.revoke(ctx.principal.org.orgId, input, actorOf(ctx)),
        ),
    }),

    authz: router({
      /**
       * The permission debug surface (§10.7).
       *
       * Behind `audit:read` — Owner and Admin — because it reports another
       * user's access, which is exactly the information an attacker would want
       * before choosing a target. The UI for this lands with `apps/web`; the
       * trace it renders is produced here so the two cannot disagree.
       */
      explain: route({ permission: 'audit:read' })
        .input(
          z
            .object({
              userId: UserIdSchema,
              permission: z.string().max(60),
              resourceType: z.string().max(40).nullable().default(null),
              resourceId: z.string().uuid().nullable().default(null),
            })
            .strict(),
        )
        .output(
          z.object({
            allowed: z.boolean(),
            reason: z.string(),
            role: z.string(),
            trace: z
              .array(
                z.object({
                  layer: z.number(),
                  outcome: z.string(),
                  rule: z.string(),
                  detail: z.string().optional(),
                }),
              )
              .readonly(),
            formatted: z.string(),
          }),
        )
        .query(({ input, ctx }) => authz.explain(ctx.principal.org.orgId, input)),
    }),

    audit: router({
      list: route({ permission: 'audit:read' })
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(200).default(50),
              before: z.string().regex(/^\d+$/).nullable().default(null),
            })
            .strict(),
        )
        .output(
          z
            .array(
              z.object({
                id: z.string(),
                seq: z.string(),
                occurredAt: z.date(),
                actorId: z.string().nullable(),
                /* Resolved at read time, never stored on the hashed entry —
                   see `readAuditEntries`. Null with a non-null `actorId` means
                   the account is gone, which is different from the system
                   having acted. */
                actorEmail: z.string().nullable(),
                action: z.string(),
                resourceType: z.string().nullable(),
                resourceId: z.string().nullable(),
                changes: z.unknown(),
                requestId: z.string().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => audit.listAuditEntries(ctx.principal.org.orgId, input)),

      /**
       * Recomputes the hash chain and reports every break (§8.6).
       *
       * `audit:export` rather than `audit:read`: a verification result is a
       * statement about the integrity of the compliance record, and the
       * capability to make that statement belongs with the Owner-only right to
       * take the record out of the system.
       */
      verify: route({ permission: 'audit:export' })
        .output(
          z.object({
            verified: z.number().int().nonnegative(),
            intact: z.boolean(),
            breaks: z
              .array(z.object({ seq: z.string(), id: z.string(), reason: z.string() }))
              .readonly(),
          }),
        )
        .query(({ ctx }) => audit.verifyAuditLog(ctx.principal.org.orgId)),
    }),
  });
}

/** Re-exported so the org resolution header has one definition. */
export { ORG_HEADER } from './resolve.js';
export { OrgIdSchema };
