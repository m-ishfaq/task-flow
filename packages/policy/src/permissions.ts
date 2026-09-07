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

  /* Search (Phase 8) — a membership-level floor; every hit is re-checked with
     per-resource can() before it is returned (§2 of ai/phase-8-search.md).

     Deliberately NOT a resource type in the list above: `search` is not
     something a relationship tuple can point at — there is no search row to
     hold a relation on, which is why migration 0005's tuples_object_type CHECK
     does not admit it. `resourceOf('search:query')` is never invoked because
     search has no `enforce()` layer — the route floor is `couldGrant`, and
     the real gate is per-hit `can()` on the four real resource types. */
  'search:query',

  /* Sharing a saved search with the whole org (Phase 8 Wave 3, §3.2). The
     second half of views' two-tier split, applied at org scope: keeping a
     PRIVATE saved search is `search:query` — if you may run a search you may
     bookmark one — and putting one in front of every colleague is this.

     It is a separate permission rather than a reuse of `org:update` because
     the two are not the same act: renaming the organization and adding an
     entry to a shared list have no reason to move together, and reusing one
     for the other is how a permission ends up meaning "administrator" rather
     than meaning something.

     Deliberately NOT in `ORG_LEVEL_PERMISSIONS` below, for the reason that
     list states about itself: it names permissions where `route()`'s pre-check
     IS the whole decision. No route declares this one as its floor — the saved
     search routes float on `search:query` and the service asks for this
     separately, with no target, so it is answered by ROLE ALONE. That second
     role-only call is exactly the shape `channel:create` uses to defeat a
     `couldGrant` false positive. */
  'search:manage',

  /* Analytics dashboards (Phase 11, ai/phase-11-analytics.md §5). An ORG-LEVEL
     read: every dashboard aggregates ACROSS boards, so a member who cannot read
     board X must not learn X's throughput from a chart. Admin + Owner only —
     they can already read every board, so an aggregate leaks nothing they could
     not assemble by hand; scoping each aggregate to the caller's readable boards
     is the named upgrade path if member-level analytics is ever wanted, not
     built here (§7 decision 4). Structurally identical to `audit:read`: it is in
     `ORG_LEVEL_PERMISSIONS` below so a channel tuple can never satisfy it (the
     `couldGrant` vulnerability that block documents), and — like `search:query`
     — deliberately NOT a `RESOURCE_TYPE`, because nothing holds a relationship
     tuple on "analytics". */
  'analytics:read',

  /* AI Copilot (Phase 15 §2.4, ai/phase-15-ai-copilot-and-permissions.md).
     Two independent gates, matching the split `analytics` already uses: the
     `aiAssistant` FEATURE FLAG answers "does this org's plan include AI at
     all," and this PERMISSION answers "which specific members inside an
     org-that-has-it may open the assistant." An org can be on a plan that
     includes AI and still have granted it to nobody — same as any other
     member grant.

     Org-level, deliberately not a `RESOURCE_TYPE`: the assistant itself has
     no resource a tuple could name (see `ORG_LEVEL_PERMISSIONS` below), and
     every per-resource question a tool call makes is answered again, at
     EXECUTION, against the caller's own live permissions on the resource the
     tool touches — the same "ask twice" shape `automation:manage` already
     uses for rule-building versus rule-execution. */
  'ai:use',

  /* GitHub/PR integration (Phase 15 §7, Wave 1 — read-only tools only).
     The full spec names four permissions (`pr:view`, `pr:review`, `pr:merge`,
     `repo:connect`); this is the only one Wave 1 ships, because it is the
     only one with a caller yet. `pr:review`/`pr:merge`/`repo:connect` gate
     write tools and a branch-creation action that do not exist until a later
     wave — registering them now, ahead of any code that checks them, is
     exactly the "flag/permission registered ahead of its first caller, then
     nobody comes back to wire it" gap this codebase has already hit twice
     (`aiAssistant` granted to no plan for a release cycle; `analytics`
     checked by no route for a release cycle). Org-level for the identical
     reason `ai:use` is: `pr-read.service.ts`'s functions take an `orgId` off
     the `Subject` and no per-resource target — there is no tuple a PR or a
     repo connection could be named by. */
  'pr:view',
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
 * `org:delete` and `org:billing` are not reachable through any route today,
 * but are included on the same reasoning ahead of the day one is added —
 * deleting or billing the org will never be something a resource tuple
 * grants. `apiToken:create`/`apiToken:revoke` WERE in that same "ahead of
 * the day" category when this paragraph was written; `apiToken.router.ts`
 * (Phase 10 Wave 3) is the route that arrived, and the reasoning held —
 * minting or revoking your own API credentials is still never something a
 * resource tuple should be able to satisfy.
 *
 * The telephony permissions were once excluded here with the note that "those
 * phases have not shipped". Phase 7 shipped five waves and a UI, and the
 * exclusion outlived the premise: `couldGrant` fell through to the tuple
 * check, `member`'s grant set contains every `:read` permission in the catalog
 * by suffix, and every user who joins a chat channel holds a `member` tuple on
 * it. A guest — who by role holds NOTHING — could therefore pass the floor on
 * `telephony.calls.list`, `telephony.messages.threads/.list`,
 * `telephony.numbers.list` and both spend routes, none of which ask a second
 * question, and read the org's whole call and SMS history with decrypted
 * counterparties. Exactly the `audit:read` vulnerability above, rebuilt in a
 * later phase because the list was not revisited when the phase landed.
 *
 * `phoneNumber`, `call`, `sms` and `recording` ARE in `RESOURCE_TYPES`, so a
 * tuple could in principle name one — but nothing in the product creates such
 * a tuple, and no telephony service calls `enforce`/`can` on a per-resource
 * target. Until one does, a tuple must not satisfy these floors. The same
 * "included ahead of the day a route arrives" reasoning as `org:delete` above
 * covers the write halves.
 *
 * NOT here, deliberately: `space:read`. A Docs space is genuinely
 * tuple-shareable — `spaceTarget()` exists, a guest holding `viewer` on one
 * space is a supported state, and making it org-level would refuse that guest
 * at layer 1. `docs.spaces.list` had the same unfiltered-listing bug this
 * paragraph describes, and its fix is a per-space `can()` filter in the
 * service, not an entry here. See `docs/space.service.ts`.
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
  /* Phase 11 §5 — analytics is an org-level capability answered by ROLE ALONE:
     no route loads a per-resource target for it and no service asks a second
     question, so `route()`'s floor IS the whole decision, exactly like
     `audit:read` directly above. A chat-channel tuple must never satisfy it. */
  'analytics:read',
  'apiToken:create',
  'apiToken:revoke',
  /* Phase 10 §9 decision 4. All three were absent purely because nothing had
     ever used them — an omission rather than a decision — and Phase 10 is the
     first caller, so the question had to be answered before a route existed.
     A rule, a webhook endpoint and an integration are org furniture: there is
     no resource for a relationship tuple to point at, so a tuple must not be
     able to satisfy the route floor.

     For automations specifically this matters twice over, because the floor is
     genuinely the whole decision at this layer: `automation.service.ts` asks no
     second per-resource question, since the resource-aware check happens later
     and elsewhere — at EXECUTION, against the rule owner's live permissions,
     in the worker. */
  'automation:manage',
  'webhook:manage',
  'integration:manage',
  /* Phase 7. A phone number, a call record, an SMS thread and a recording are
     org furniture in exactly the sense the block comment describes: the
     services behind every route that names one take an `orgId` and no subject,
     so `route()`'s floor is the entire decision and a chat-channel tuple must
     never reach it. */
  'phoneNumber:read',
  'phoneNumber:purchase',
  'phoneNumber:release',
  'call:read',
  'call:place',
  'sms:read',
  'sms:send',
  'recording:read',
  'recording:export',
  /* Phase 15 §2.4. The assistant is org furniture in the identical sense:
     `ai.service.ts` (§4 onward) takes an `orgId` and no per-resource subject
     when deciding WHETHER the assistant may be opened at all — the
     resource-aware questions happen later, per tool call, against the
     resource the tool names. A chat-channel tuple must never satisfy this
     floor any more than it may satisfy `automation:manage`. */
  'ai:use',
  /* Phase 15 §7 Wave 1. Same reasoning as `ai:use` directly above: the
     connector is org furniture (`platform.integrations` has no per-resource
     tuple target), so a channel or board tuple must never satisfy this
     floor either. */
  'pr:view',
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

/**
 * Permissions eligible to be granted to one specific member individually, on
 * top of their role (ai/phase-15-ai-copilot-and-permissions.md §1) — the
 * `authz.member_grants` table (migration 0097).
 *
 * Deliberately a separate, narrower list from the full catalog, checked at
 * the write path (`apps/api/src/tenancy/member-grant.service.ts`) rather
 * than as a CHECK constraint in the migration — see that migration's own
 * comment for why. Not every permission should ever be individually
 * grantable: ownership-adjacent and destructive org-wide capabilities
 * (`org:update`, `org:delete`, `member:manage`, role changes, ...) stay
 * role-only regardless of this mechanism existing. A permission landing here
 * is a deliberate, reviewed decision — same discipline as `ORG_LEVEL_PERMISSIONS`
 * above — not a default every permission gets.
 *
 * Wave 1's starting set is exactly the telephony permissions
 * `roles.ts` already hands to the whole Member role with no way to
 * restrict them to specific people — the gap that motivated building this
 * mechanism at all (see the phase spec's §0). They stay on the Member role
 * for now: this list makes them ALSO grantable to a Guest, who holds
 * nothing from their role, without promoting them to Member — e.g. giving
 * one contractor calling ability without giving them read access to every
 * board. Retiring the blanket Member-role grant in favor of this list being
 * the only source is a deliberate follow-up (needs a data migration
 * backfilling existing orgs' grants first), not bundled into the wave that
 * introduces the mechanism.
 *
 * Wave 2 adds the four automation permissions (`automation:manage`,
 * `webhook:manage`, `integration:manage`, `apiToken:create`,
 * `apiToken:revoke` — five entries, `apiToken` split across the matrix
 * pair). Unlike telephony, none of these were ever on the Member role — an
 * org that wants ONE Member able to build rules, or manage the webhook
 * registry, without promoting them to Admin previously had no way to say
 * that at all. This is safe to grant narrowly for the same reason it is
 * safe to grant to Admin at every org: `automation.service.ts` asks no
 * per-resource question when a rule is BUILT, because the resource-aware
 * question is asked again at EXECUTION, in the worker, against the rule
 * owner's own live permissions re-resolved on every run (see
 * `apps/worker/src/automation/executor.ts`). A Member granted
 * `automation:manage` can therefore only build rules whose actions their
 * OWN permissions already allow — granting the ABILITY TO BUILD does not
 * also grant the actions a built rule may take. `integration:manage` and
 * `apiToken:create`/`revoke` are still stepUp-gated at their own routes
 * regardless of how the floor permission was obtained, so a hijacked
 * session cannot use an individual grant to skip that ceremony either.
 *
 * Wave 3 (Phase 15 §2.4) adds `ai:use`. Owner and Admin hold it by role, same
 * as `automation:manage` — this is what makes it grantable to a Member or
 * Guest individually rather than only ever reachable by promotion.
 *
 * Wave 4 (Phase 15 §7 Wave 1) adds `pr:view` — same shape as `ai:use`:
 * Owner/Admin hold it by role, and this is what lets an org grant it to one
 * Member without promoting them.
 */
export const GRANTABLE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'phoneNumber:read',
  'call:place',
  'call:read',
  'sms:send',
  'sms:read',
  'automation:manage',
  'webhook:manage',
  'integration:manage',
  'apiToken:create',
  'apiToken:revoke',
  'ai:use',
  'pr:view',
]);

/** True when `permission` may be granted to an individual member — see `GRANTABLE_PERMISSIONS`. */
export function isGrantable(permission: Permission): boolean {
  return GRANTABLE_PERMISSIONS.has(permission);
}
