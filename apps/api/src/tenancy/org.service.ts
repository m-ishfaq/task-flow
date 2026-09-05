import { and, eq, schema, withOrgScope, withUserScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { can, type Subject } from '@taskflow/policy';
import { orgCreated, orgUpdated } from './events.js';
import { trialStarted } from '../billing/events.js';

/**
 * Organizations (PLAN.md §7, §8.2).
 *
 * Creating one is the only mutation in the tenancy module that is NOT an org
 * capability — there is no permission for it, because the caller is not in an
 * organization yet. See the route in router.ts for why that makes it a
 * `selfRoute` rather than a hole in guardrail 4.
 */

export interface Actor {
  readonly userId: UserId;
  readonly requestId: RequestId;
}

/**
 * The plan every new org is placed on (migration 0094). Hardcoded, not read
 * from a marker column like `billing.plans.is_default` — which plan lands an
 * *expiring* trial is a real, recurring operator decision (§3.6), but which
 * plan IS the trial is structural: it is the specific row migration 0094
 * creates for this exact call site, not something meant to move to a
 * different existing plan without a matching code change regardless.
 */
const TRIAL_PLAN_ID = 'trial';

/** SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface CreateOrgInput {
  readonly name: string;
  readonly slug: string;
}

export interface CreateOrgDeps {
  /** Phase 12 Wave 3 §3.4 — how long a new org's trial runs before the sweep touches it. */
  readonly trialDays: number;
  /** Overridable for tests; defaults to the real clock. */
  readonly now?: () => Date;
}

/**
 * Creates an organization and makes the caller its owner.
 *
 * The whole thing is ONE transaction, and that is not merely tidy. An org with
 * no membership row is unreachable by anyone — including the person who just
 * created it — and unreachable by definition, since every route needs a
 * membership to resolve a role. A partial success here would produce a tenant
 * that exists, holds a globally-unique slug, and can never be entered or
 * deleted.
 *
 * The scope is the org being created. That reads circular and is not: ids are
 * generated here (UUIDv7, §7.1), so the id exists before the row does, and the
 * RLS `WITH CHECK` on identity.orgs is satisfied by the scope this function
 * opened. No privileged path, and nothing for a later change to reach for.
 */
/**
 * `deps.trialDays` defaults to 14 — production never relies on the default
 * (`tenancy/router.ts` always passes the real, env-derived value explicitly)
 * — it exists so the ~20 unrelated test suites across this codebase that
 * call `createOrg` purely to get a tenant to test something else against do
 * not all need updating for a value none of them assert on.
 */
export async function createOrg(
  input: CreateOrgInput,
  actor: Actor,
  deps: CreateOrgDeps = { trialDays: 14 },
): Promise<{ orgId: OrgId; slug: string }> {
  /* Phase 12 Wave 1 (§3.4): an unverified account may not create an org. The
     gate lives BEFORE the transaction opens because it is a precondition on
     the ACTOR, not part of the org write — and because self-serve creation
     was the abuse surface the wave exists to bound. `identity.users` carries
     no RLS, so the read works in any scope; `withUserScope` is used because
     it is the established idiom for "a fact about this actor" in this file
     (resolve.ts uses it identically), not because it is structurally
     required. */
  const verified = await withUserScope(actor.userId, async (tx) => {
    const rows = await tx
      .select({ emailVerifiedAt: schema.users.emailVerifiedAt })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
      .limit(1);
    return rows[0]?.emailVerifiedAt ?? null;
  });

  if (verified === null) {
    throw errors.validation(
      { _: 'Please verify your email address before creating an organization.' },
      'Email verification required.',
    );
  }

  const orgId = newId<'OrgId'>();
  const membershipId = newId<'MembershipId'>();

  /* Phase 12 Wave 3 (§3.4): the trial starts HERE, in the same transaction as
     the org itself — there is no "org exists but has no billing state yet"
     moment for a later step to fill in, the identical reasoning the founding
     membership above already follows. `billingStatus` defaults to 'trialing'
     at the column level (migration 0059); `trialEndsAt` is the one value only
     this call site can supply. */
  const now = (deps.now ?? (() => new Date()))();
  const trialEndsAt = new Date(now.getTime() + deps.trialDays * 24 * 60 * 60 * 1000);

  try {
    await withOrgScope(orgId, async (tx) => {
      await tx.insert(schema.orgs).values({
        id: orgId,
        name: input.name,
        slug: input.slug,
        trialEndsAt,
        /* Migration 0094 (packages/feature-flags/src/flags.ts's own header
           explains why): every module flag now defaults to `false`, so a
           `plan_id` of NULL would mean this org sees nothing at all the
           moment it exists. `trial` is a real, non-purchasable plan row
           granting the full trial preview — assigned here, in the same
           transaction as the org itself, for the same "no half-created org"
           reasoning the membership insert below already follows. It is
           never `is_active`, so no owner can pick it from the upgrade
           picker and no operator can move an existing org onto it through
           `plans.setOrgPlan` — this INSERT is the one door onto it. */
        planId: TRIAL_PLAN_ID,
      });

      await tx.insert(schema.memberships).values({
        id: membershipId,
        orgId,
        userId: actor.userId,
        role: 'owner',
        // Null, not the creator's own id: they were invited by nobody, and
        // recording self-invitation would make the audit trail claim an event
        // that did not happen.
        invitedBy: null,
      });

      await outboxWriter.append(tx, [
        createEvent(
          orgCreated,
          { orgId, name: input.name, slug: input.slug, ownerId: actor.userId },
          { orgId, actorId: actor.userId, requestId: actor.requestId },
        ),
        createEvent(
          trialStarted,
          { orgId, trialEndsAt: trialEndsAt.toISOString() },
          { orgId, actorId: actor.userId, requestId: actor.requestId },
        ),
      ]);
    });
  } catch (error) {
    // The slug is globally unique because it appears in URLs and in mail. A
    // collision is a client error, not a server fault.
    if (isUniqueViolation(error)) {
      throw errors.conflict('That organization address is already taken.');
    }
    throw error;
  }

  return { orgId, slug: input.slug };
}

export interface OrgSummary {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
}

/**
 * Every organization the caller belongs to — the org switcher.
 *
 * The one query in the system that spans tenants, and the only reason
 * `withUserScope` exists. It is safe because the two policies keyed on
 * `app.user_id` are SELECT-only and match the caller's own membership rows;
 * everything else still filters on `app.org_id`, which this scope clears.
 */
export async function listMyOrgs(userId: UserId): Promise<readonly OrgSummary[]> {
  return withUserScope(userId, async (tx) =>
    tx
      .select({
        orgId: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.memberships.orgId))
      .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, 'active')))
      .orderBy(schema.orgs.name),
  );
}

/**
 * What the Settings page's admin controls are for, computed once from the
 * SAME `can()` the routes themselves enforce — the chat channel precedent
 * (`capabilitiesFor` in `chat/shared.ts`). The client may hide a control it is
 * told it does not have; it never decides anything. If this and the route's
 * own permission check ever disagreed, the route is what would refuse the
 * request — these booleans are a rendering hint, not a second gate.
 *
 * All five are ORG_LEVEL permissions (`packages/policy/src/permissions.ts`),
 * so a plain role check with no target is the correct and complete answer —
 * there is no per-resource tuple that could grant any of them.
 */
export interface SettingsCapabilities {
  /** Rename the organization. */
  readonly updateOrg: boolean;
  /** Add an existing user as a member. */
  readonly inviteMember: boolean;
  /** Change a member's role; transfer ownership (both are `member:manage`). */
  readonly manageMembers: boolean;
  /** Remove a member from the organization. */
  readonly removeMembers: boolean;
  /** Create a team; add or remove a team's members. */
  readonly manageTeams: boolean;
  /**
   * Create a project, or duplicate an existing one (`work/project.service.ts`
   * — `duplicate` is floored on the identical `project:create`). Not one of
   * `packages/policy`'s formal ORG_LEVEL_PERMISSIONS, but behaves the same
   * way here for the same reason: creating a project has no existing
   * resource to hold a tuple, so `can()` called with no target resolves from
   * role alone regardless of that list's membership (`decide.ts`'s own `if
   * (!target)` branch). Bundled onto this org-wide object rather than a
   * separate query — Work's per-project/per-board capabilities are computed
   * where those rows already are (`work/project.service.ts`,
   * `work/board.service.ts`), because THOSE really do vary by resource.
   */
  readonly createProject: boolean;
  /**
   * May open `/analytics` at all — `analytics:read`, Admin-and-Owner-only by
   * role alone (Phase 11 §5). The sidebar (`sidebar.tsx`) reads this to hide
   * the nav item entirely for a Member, rather than showing it and letting
   * the page answer FORBIDDEN — there is no plan upgrade or grant that turns
   * this on for a Member the way there is for e.g. telephony, so a locked
   * icon here would advertise a door nothing can open for them.
   */
  readonly viewAnalytics: boolean;
  /** Same reasoning again, for the "Audit log" link and `audit:read`. */
  readonly viewAuditLog: boolean;
  /**
   * The four `/automations` tabs, UNLIKE `viewAnalytics`/`viewAuditLog`
   * above: `automation:manage`, `webhook:manage`, `integration:manage` and
   * `apiToken:create`/`apiToken:revoke` joined `GRANTABLE_PERMISSIONS` in
   * Wave 2 (`packages/policy/src/permissions.ts`), so — exactly like the
   * five telephony booleans below — these are not all-or-nothing by role.
   * Admin and Owner hold all five by role; a Member holds each only via an
   * explicit `authz.member_grants` row, so someone granted only
   * `webhook:manage` needs `/automations` to open (there is no single
   * `viewAutomations` flag to gate the route on any more) and land on the
   * Webhooks tab specifically, not Rules. `readApiTokens` does not exist:
   * `apiToken.router.ts`'s `list`/`heldScopes` both floor on
   * `apiToken:create`, matching `createApiTokens` below — reading the list
   * is bundled with minting, not a third capability.
   */
  readonly manageAutomations: boolean;
  readonly manageWebhooks: boolean;
  readonly manageIntegrations: boolean;
  readonly createApiTokens: boolean;
  readonly revokeApiTokens: boolean;
  /**
   * The five telephony permissions (`GRANTABLE_PERMISSIONS`,
   * `packages/policy/src/permissions.ts`), UNLIKE the three above, are not
   * all-or-nothing by role: Admin and Owner hold all five by role, but a
   * Member holds each independently, only via an explicit
   * `authz.member_grants` row (migration 0097/0098). So these are five
   * booleans, not one — someone can have `readSms` and nothing else, and the
   * UI must reflect exactly that, not "has telephony" as a single flag.
   */
  readonly readPhoneNumbers: boolean;
  readonly placeCalls: boolean;
  readonly readCalls: boolean;
  readonly sendSms: boolean;
  readonly readSms: boolean;
  /**
   * May open `/settings` → Billing at all, or the mobile Billing screen —
   * `org:billing`, Owner-only by role alone (no tuple, no member grant: it
   * is not in `GRANTABLE_PERMISSIONS`). Same reasoning as `viewAnalytics`:
   * nothing ever turns this on for a non-owner, so a locked icon would
   * advertise a door nobody but the current owner can open — hide it
   * entirely rather than show it and let it 403.
   */
  readonly viewBilling: boolean;
  /**
   * Buying/releasing a phone number on `/calls` → Numbers — `phoneNumber:
   * purchase`/`phoneNumber:release`, Owner-only (unlike `readPhoneNumbers`
   * above, NEITHER is in `GRANTABLE_PERMISSIONS`: reading the org's numbers
   * is delegable, spending money on a new one or giving one up is not).
   * `numbers-panel.tsx` used to render both buttons for every viewer
   * holding `readPhoneNumbers` and let a non-owner's click come back
   * FORBIDDEN — its own doc comment said so explicitly (Phase 15 §1's
   * sweep).
   */
  readonly purchaseNumbers: boolean;
  readonly releaseNumbers: boolean;
  /**
   * Sharing a saved search with the whole org — `search:manage`,
   * Admin-and-Owner only by role (`packages/policy/src/roles.ts`'s own
   * comment: "unlike `recording:export` or `phoneNumber:purchase` the
   * worst case is clutter, not a bill or a leaked conversation" — Admin
   * gets it for that reason, where telephony spend stays Owner-only).
   * `search-page.tsx`'s "Share with the organization" checkbox used to
   * render for every caller and let a Member's tick come back FORBIDDEN.
   */
  readonly manageSavedSearches: boolean;
  /**
   * The Recordings section on a card, and the Spend tab's itemized report
   * (`spend-panel.tsx`) — `recording:read`, Admin-and-Owner only by role
   * alone (in `ORG_LEVEL_PERMISSIONS`, `packages/policy/src/permissions.ts`
   * — "no route declares this one as its floor... `route()`'s pre-check IS
   * the whole decision", so unlike the five telephony fields above this is
   * a flat org-wide boolean, not per-resource). `recording-section.tsx`
   * used to render on every card unconditionally and let a Member's
   * interaction come back FORBIDDEN.
   */
  readonly readRecordings: boolean;
  /**
   * Creating a new Docs SPACE — `space:create`, computed with no target
   * (like `createProject` above) since a not-yet-created space has no
   * resource to scope a tuple to. Unlike `createProject`, this permission
   * genuinely can ALSO be satisfied by a tuple once a space exists
   * (`space:manage` is per-space, and `docs.spaces.list` already returns
   * that half in its own `capabilities.manage`); this field only ever
   * answers the org-wide "create" question, the one place a tuple cannot
   * help because there is nothing yet to hold one.
   */
  readonly createSpace: boolean;
}

export interface OrgDetail {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly capabilities: SettingsCapabilities;
}

/**
 * The current organization. Scoped, so there is no id to pass and none to forge.
 *
 * Deliberately does not return the caller's role: it is already on the
 * principal, having come from the membership read that authorized this call.
 * Returning it here would be a second source for one fact, and the two would
 * eventually disagree. `capabilities` is not that — it is the OUTCOME of the
 * role, not a restatement of it, the same distinction `getOrg`'s doc comment
 * already draws for `role` itself.
 */
export async function getOrg(orgId: OrgId, subject: Subject): Promise<OrgDetail> {
  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({
        orgId: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        createdAt: schema.orgs.createdAt,
      })
      .from(schema.orgs)
      .limit(1),
  );

  const org = rows[0];
  if (!org) throw errors.notFound();

  return {
    ...org,
    capabilities: {
      updateOrg: can(subject, 'org:update').allowed,
      inviteMember: can(subject, 'member:invite').allowed,
      manageMembers: can(subject, 'member:manage').allowed,
      removeMembers: can(subject, 'member:remove').allowed,
      manageTeams: can(subject, 'team:manage').allowed,
      createProject: can(subject, 'project:create').allowed,
      /* Nav-visibility capabilities, not settings-page ones — the sidebar
         reads these too (see sidebar.tsx). Analytics and the audit log are
         each Admin-and-Owner-only by ROLE ALONE (no per-resource target),
         with no separate "read" tier a Member could hold — a plan-flag lock
         icon says "your ORG could have this," which is true and worth
         showing; nothing about a Member's ROLE ever becomes true by
         upgrading a plan, so showing the same lock icon for that case would
         be advertising a door that plan money can never open for them. */
      viewAnalytics: can(subject, 'analytics:read').allowed,
      viewAuditLog: can(subject, 'audit:read').allowed,
      /* Individually granted (Phase 15 §1) — see the interface doc comment.
         Each reads `subject.memberGrants` through the same `can()` a route
         floors on, so a grant made in Settings shows up here with no second
         source of truth. */
      readPhoneNumbers: can(subject, 'phoneNumber:read').allowed,
      placeCalls: can(subject, 'call:place').allowed,
      readCalls: can(subject, 'call:read').allowed,
      sendSms: can(subject, 'sms:send').allowed,
      readSms: can(subject, 'sms:read').allowed,
      /* Wave 2 — see the interface doc comment. Individually granted exactly
         like the telephony five above, unlike Analytics/audit above them. */
      manageAutomations: can(subject, 'automation:manage').allowed,
      manageWebhooks: can(subject, 'webhook:manage').allowed,
      manageIntegrations: can(subject, 'integration:manage').allowed,
      createApiTokens: can(subject, 'apiToken:create').allowed,
      revokeApiTokens: can(subject, 'apiToken:revoke').allowed,
      viewBilling: can(subject, 'org:billing').allowed,
      purchaseNumbers: can(subject, 'phoneNumber:purchase').allowed,
      releaseNumbers: can(subject, 'phoneNumber:release').allowed,
      manageSavedSearches: can(subject, 'search:manage').allowed,
      readRecordings: can(subject, 'recording:read').allowed,
      createSpace: can(subject, 'space:create').allowed,
    },
  };
}

export async function updateOrg(
  orgId: OrgId,
  input: { readonly name: string },
  actor: Actor,
): Promise<{ readonly name: string }> {
  return withOrgScope(orgId, async (tx) => {
    const existing = await tx
      .select({ name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const before = existing[0];
    if (!before) throw errors.notFound();

    await tx
      .update(schema.orgs)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(schema.orgs.id, orgId));

    await outboxWriter.append(tx, [
      createEvent(
        orgUpdated,
        { orgId, before: { name: before.name }, after: { name: input.name } },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { name: input.name };
  });
}
