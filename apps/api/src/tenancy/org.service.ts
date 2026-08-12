import { and, eq, schema, withOrgScope, withUserScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
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
     at the column level (migration 0055); `trialEndsAt` is the one value only
     this call site can supply. */
  const now = (deps.now ?? (() => new Date()))();
  const trialEndsAt = new Date(now.getTime() + deps.trialDays * 24 * 60 * 60 * 1000);

  try {
    await withOrgScope(orgId, async (tx) => {
      await tx
        .insert(schema.orgs)
        .values({ id: orgId, name: input.name, slug: input.slug, trialEndsAt });

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

export interface OrgDetail {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
}

/**
 * The current organization. Scoped, so there is no id to pass and none to forge.
 *
 * Deliberately does not return the caller's role: it is already on the
 * principal, having come from the membership read that authorized this call.
 * Returning it here would be a second source for one fact, and the two would
 * eventually disagree.
 */
export async function getOrg(orgId: OrgId): Promise<OrgDetail> {
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
  return org;
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
