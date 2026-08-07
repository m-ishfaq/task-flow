/**
 * The permission catalog — every action the system can authorize (PLAN.md §8.2).
 *
 * Permissions are `<resource>:<action>` strings, and this list is CLOSED: a
 * route may only declare a permission that appears here. That is what makes
 * guardrail 4 buildable — a typo in a route's `.meta({ permission })` has to be
 * a compile error, because a permission nobody grants would otherwise deny
 * silently, and a permission nobody checks would allow silently. Both failures
 * look like working software.
 *
 * Adding one is deliberately a three-place change: here, in the role matrix
 * (roles.ts), and in the matrix test. A permission with no row in the matrix
 * fails a test rather than defaulting to anything.
 */

export const RESOURCE_TYPES = [
  'org',
  'member',
  'team',
  'project',
  'board',
  'card',
  'channel',
  'message',
  'space',
  'page',
  'comment',
  'attachment',
  'automation',
  'webhook',
  'integration',
  'phoneNumber',
  'call',
  'sms',
  'recording',
  'audit',
  'apiToken',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const PERMISSIONS = [
  /* Organization — the capabilities that can end the company's tenancy. */
  'org:read',
  'org:update',
  'org:delete',
  'org:billing',

  /* Membership. `member:invite` and `member:manage` are separate because Admin
     has the first and not the second: an admin who could edit roles could
     promote themselves to Owner, which makes the Owner/Admin split decorative. */
  'member:read',
  'member:invite',
  'member:manage',
  'member:remove',

  'team:read',
  'team:manage',

  /* Work */
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

  /* Chat */
  'channel:read',
  'channel:create',
  'channel:manage',
  'message:read',
  'message:create',
  'message:update',
  'message:delete',

  /* Docs */
  'space:read',
  'space:create',
  'space:manage',
  'page:read',
  'page:create',
  'page:update',
  'page:delete',
  /* Admin/owner only — see roles.ts. Publishing exposes a page's current
     content with no session required at all, which is a bigger unilateral
     exposure decision than editing it, the same distinction that keeps
     `message:delete`/`comment:delete` out of MEMBER's list. */
  'page:publish',

  /* Cross-cutting collaboration */
  'comment:create',
  'comment:delete',
  'attachment:upload',
  'attachment:download',

  /* Platform */
  'automation:manage',
  'webhook:manage',
  'integration:manage',
  'apiToken:create',
  'apiToken:revoke',

  /* Telephony — the group where a mistake costs money rather than privacy
     (§8.5). Purchasing numbers and exporting recordings are Owner-only. */
  'phoneNumber:read',
  'phoneNumber:purchase',
  'phoneNumber:release',
  'call:place',
  'call:read',
  'sms:send',
  'sms:read',
  'recording:read',
  'recording:export',

  /* Compliance */
  'audit:read',
  'audit:export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/**
 * Permissions with no per-resource concept at all: the capability acts on
 * "the org" or "membership" itself, never on a row a tuple could point at, and
 * — verified against every `enforce()`/`can()` call site in `apps/api/src` —
 * no service behind any of these ever calls either again, in ANY form, once
 * `route()`'s pre-check has passed. That absence is exactly what makes them
 * different from the rest of the catalog.
 *
 * `decide.ts`'s `couldGrant` is the reason this list exists. For every OTHER
 * permission, a coarse layer-1 pass granted by an unrelated tuple is safe: a
 * real per-resource layer 2 always runs afterward and narrows it back down —
 * `enforceOnChannel`/`enforceOn` with the loaded row's own target, or, for a
 * handful of routes with no parent resource to load (`channel:create`), a
 * SECOND role-only `enforce()` call that would deny a false positive on its
 * own terms regardless of what layer 1 said. These permissions have neither:
 * `org.service.ts`, `member.service.ts`, `team.service.ts`, and
 * `audit.service.ts`'s `listAuditEntries` never call `enforce`/`can` a second
 * time, so `route()`'s pre-check IS the entire authorization decision — and
 * letting a tuple satisfy it here was a real vulnerability (any member of any
 * channel could read the whole org audit log through it; see
 * `ai/phase-5-chat.md`'s findings on `couldGrant`).
 *
 * `org:delete`, `org:billing`, `apiToken:create` and `apiToken:revoke` are not
 * reachable through any route today, but are included on the same reasoning
 * ahead of the day one is added — deleting or billing the org, or minting
 * your own API credentials, will never be something a resource tuple grants.
 *
 * Telephony and platform permissions (`phoneNumber:*`, `automation:manage`,
 * ...) are deliberately NOT here: those phases have not shipped, and whether
 * a future phone number or automation becomes independently tuple-shareable
 * is a decision for whoever builds it, not one to guess at now.
 */
const ORG_LEVEL_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'org:read',
  'org:update',
  'org:delete',
  'org:billing',
  'member:read',
  'member:invite',
  'member:manage',
  'member:remove',
  'team:read',
  'team:manage',
  'audit:read',
  'apiToken:create',
  'apiToken:revoke',
]);

/** True when `permission` has no per-resource concept — see `ORG_LEVEL_PERMISSIONS`. */
export function isOrgLevel(permission: Permission): boolean {
  return ORG_LEVEL_PERMISSIONS.has(permission);
}

/** Narrows an arbitrary string to a known permission. Used at trust boundaries. */
export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Permissions that only read. Used by the restrictive-relation logic in
 * decide.ts, which caps a `viewer` grant to exactly this set.
 *
 * Derived from the action suffix rather than listed by hand, so a new
 * `foo:read` is covered the day it is added. Listing them manually is how a
 * write permission eventually ends up inside the read-only cap.
 */
export function isReadOnly(permission: Permission): boolean {
  const action = permission.slice(permission.indexOf(':') + 1);
  return action === 'read' || action === 'download';
}

/** The resource type a permission acts on. */
export function resourceOf(permission: Permission): ResourceType {
  return permission.slice(0, permission.indexOf(':')) as ResourceType;
}
