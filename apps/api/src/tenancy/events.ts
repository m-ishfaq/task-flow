import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Tenancy and authorization domain events — guardrail 11 (PLAN.md §2.1, §8.6).
 *
 * These are the highest-value entries the audit log will ever hold. Everything
 * else in the system records what someone did with their access; these record
 * how the access itself changed. "Who made this person an admin, and when" is
 * the first question of any incident, and the only place it can be answered is
 * a record written at the moment it happened.
 *
 * Every payload carries the BEFORE value where one exists. A role change event
 * saying only `role: 'owner'` cannot answer "was this an escalation?" without
 * replaying the whole stream, which is exactly the reconstruction an audit log
 * is supposed to make unnecessary.
 */

export const orgCreated = defineEvent(
  'org.created',
  z.object({ orgId: z.string(), name: z.string(), slug: z.string(), ownerId: z.string() }).strict(),
);

export const orgUpdated = defineEvent(
  'org.updated',
  z
    .object({
      orgId: z.string(),
      before: z.object({ name: z.string() }).strict(),
      after: z.object({ name: z.string() }).strict(),
    })
    .strict(),
);

/**
 * A user became a member of an organization.
 *
 * `invitedBy` is nullable for the founding owner, who was invited by nobody —
 * a real value rather than a missing one.
 */
export const memberAdded = defineEvent(
  'member.added',
  z
    .object({
      membershipId: z.string(),
      userId: z.string(),
      email: z.string(),
      role: z.string(),
      invitedBy: z.string().nullable(),
    })
    .strict(),
);

/**
 * The single most security-relevant event in the system.
 *
 * Both roles are recorded because the direction is what matters: member ->
 * admin and admin -> member are the same event name and opposite incidents.
 */
export const memberRoleChanged = defineEvent(
  'member.role_changed',
  z
    .object({
      membershipId: z.string(),
      userId: z.string(),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
);

export const memberRemoved = defineEvent(
  'member.removed',
  z.object({ membershipId: z.string(), userId: z.string(), role: z.string() }).strict(),
);

export const teamCreated = defineEvent(
  'team.created',
  z.object({ teamId: z.string(), name: z.string(), slug: z.string() }).strict(),
);

export const teamMemberAdded = defineEvent(
  'team.member_added',
  z.object({ teamId: z.string(), userId: z.string() }).strict(),
);

export const teamMemberRemoved = defineEvent(
  'team.member_removed',
  z.object({ teamId: z.string(), userId: z.string() }).strict(),
);

/**
 * A relationship tuple was written or withdrawn (§8.2).
 *
 * Separate from role changes because they answer different questions: a role
 * says what someone can do across the org, a tuple says what they can do to one
 * specific thing. An investigation asking "how did this contractor reach that
 * board" is looking for these.
 */
export const grantCreated = defineEvent(
  'grant.created',
  z
    .object({
      tupleId: z.string(),
      subjectType: z.enum(['user', 'team']),
      subjectId: z.string(),
      relation: z.string(),
      objectType: z.string(),
      objectId: z.string(),
      expiresAt: z.string().nullable(),
    })
    .strict(),
);

export const grantRevoked = defineEvent(
  'grant.revoked',
  z
    .object({
      tupleId: z.string(),
      subjectType: z.enum(['user', 'team']),
      subjectId: z.string(),
      relation: z.string(),
      objectType: z.string(),
      objectId: z.string(),
    })
    .strict(),
);

/*
 * NOT HERE YET: `access.denied`.
 *
 * §8.2 gives the decision trace three uses — the debug endpoint, the matrix
 * test's failure output, and a structured field on every audited denial. The
 * first two exist; the third does not, and an event defined here that nothing
 * emits would read like the control was in place.
 *
 * What it needs first is a decision about cost. A denial happens before any
 * transaction is open, so auditing one means a write on a path that an
 * unauthenticated caller can trigger at will — the audit log would become the
 * cheapest amplification target in the system. The likely shape is sampling
 * plus per-actor aggregation, which belongs with the notification and rate-limit
 * work in Phase 9 rather than being improvised here.
 */
