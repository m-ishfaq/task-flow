import { PERMISSIONS, type Permission } from './permissions.js';

/**
 * Organization roles and what each one grants (PLAN.md §8.2).
 *
 * This file and decide.ts are the only places in the workspace permitted to
 * compare a role — guardrail 7 makes `role === 'admin'` a lint error everywhere
 * else. The reason is drift: an inline check written in a route handler is
 * invisible to the matrix test, so it keeps working after the matrix changes
 * and quietly grants what the matrix now denies.
 */

export const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles are NOT a hierarchy in code, even though they read like one.
 *
 * Modelling Admin as "Member plus extras" makes every future member permission
 * silently flow to admins, which is usually right and occasionally catastrophic
 * — `recording:export` and `phoneNumber:purchase` are exactly the cases where it
 * is not. Each role lists what it has.
 */
const OWNER: readonly Permission[] = PERMISSIONS;

const ADMIN: readonly Permission[] = [
  'org:read',
  'member:read',
  'member:invite',
  'team:read',
  'team:manage',

  'project:read',
  'project:create',
  'project:update',
  'project:delete',
  'board:read',
  'board:create',
  'board:update',
  'board:delete',
  'card:read',
  'card:create',
  'card:update',
  'card:move',
  'card:delete',

  'channel:read',
  'channel:create',
  'channel:manage',
  'message:read',
  'message:create',
  'message:update',
  'message:delete',

  'space:read',
  'space:create',
  'space:manage',
  'page:read',
  'page:create',
  'page:update',
  'page:delete',

  'comment:create',
  'comment:delete',
  'attachment:upload',
  'attachment:download',

  'automation:manage',
  'webhook:manage',
  'integration:manage',
  'apiToken:create',
  'apiToken:revoke',

  'phoneNumber:read',
  'call:place',
  'call:read',
  'sms:send',
  'sms:read',
  'recording:read',

  'audit:read',

  'search:query',
  /* Sharing a saved search is administrative — it adds an entry to a list
     every member sees — and stops at Admin rather than being Owner-only,
     because unlike `recording:export` or `phoneNumber:purchase` the worst case
     is clutter, not a bill or a leaked conversation. */
  'search:manage',

  /* Analytics dashboards (Phase 11 §5, §7 decision 4). Admin AND Owner, no
     lower: the charts aggregate across every board, and Admin can already read
     every board, so the aggregate leaks nothing they could not assemble by
     hand. Member and Guest are withheld deliberately — member-level analytics
     would mean scoping each aggregate to the caller's readable boards, which is
     named as the upgrade path, not built. */
  'analytics:read',
];

const MEMBER: readonly Permission[] = [
  'org:read',
  'member:read',
  'team:read',

  'project:read',
  'board:read',
  'card:read',
  'card:create',
  'card:update',
  'card:move',
  'card:delete',

  'channel:read',
  'message:read',
  'message:create',
  'message:update',
  /* No `message:delete`. Deliberately removed in Phase 5, and the asymmetry with
     `message:update` above is the point.

     Deleting your OWN message does not need this permission — `deleteMessage`
     asks for `message:create` when the caller is the author, exactly as
     `deleteComment` does. `message:delete` is the MODERATION capability: it is
     what lets someone remove another person's words. Granting that to every
     member made any colleague able to erase any message in any channel they
     could read, which is not what "member" means anywhere else in this matrix —
     `comment:delete` is admin-and-owner only for the identical reason.

     This was a Phase 2 entry written before Chat existed, when nothing consumed
     it. It is listed here rather than silently dropped because a permission
     disappearing from a role is the kind of change that looks like an accident
     six months later. */

  'space:read',
  'page:read',
  'page:create',
  'page:update',

  'comment:create',
  'attachment:upload',
  'attachment:download',

  'phoneNumber:read',
  'call:place',
  'call:read',
  'sms:send',
  'sms:read',

  'search:query',
];

/**
 * Guest grants NOTHING from the role alone.
 *
 * Everything a guest can do arrives as a relationship tuple on a specific
 * channel or page (§8.2). An empty list is the whole point: a guest who somehow
 * reaches a resource with no tuple gets a denial from the default path, not
 * from a special case someone has to remember to write.
 */
const GUEST: readonly Permission[] = [];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: OWNER,
  admin: ADMIN,
  member: MEMBER,
  guest: GUEST,
};

/*
 * A Map keyed by `string`, not a Record keyed by `Role`.
 *
 * The type system believes every lookup succeeds, because the parameter is typed
 * `Role`. At runtime the value came from a database row or a decoded token, so a
 * role this build has never heard of is reachable during a rolling deploy. `Map`
 * makes the lookup honestly return `undefined` and lets the miss be handled
 * instead of throwing.
 */
const ROLE_SETS: ReadonlyMap<string, ReadonlySet<Permission>> = new Map([
  ['owner', new Set(OWNER)],
  ['admin', new Set(ADMIN)],
  ['member', new Set(MEMBER)],
  ['guest', new Set(GUEST)],
]);

/**
 * True when the org-level role alone grants `permission`.
 *
 * An unrecognized role grants nothing. A 500 on every request from one member
 * with a stale role row is both an availability bug and a far worse way to learn
 * about a version mismatch than a denial naming the role.
 */
export function roleGrants(role: Role, permission: Permission): boolean {
  return ROLE_SETS.get(role)?.has(permission) ?? false;
}

/**
 * Roles allowed to bypass a restrictive relationship grant.
 *
 * An Owner or Admin marked `viewer` on one board should not lose their ability
 * to administer it — they can delete the tuple anyway, so enforcing the cap
 * would only make the system confusing rather than safer. The bypass is
 * recorded as an explicit step in the decision trace so it is visible to an
 * auditor rather than being an unexplained allow.
 */
export function bypassesRestrictions(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

/** True when a value from outside the system names a real role. */
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
