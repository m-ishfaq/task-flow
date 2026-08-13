import {
  and,
  coalesceColumns,
  desc,
  eq,
  gte,
  schema,
  sumWithFallback,
  withOrgScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';
import { FLAGS, FLAG_NAMES } from '@taskflow/feature-flags';
import { getEntitlements } from '../billing/entitlement-resolver.js';
import { getFeatureFlags } from './flag-evaluator.js';
import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * One org, in full — the console's drill-down (Phase 12 Wave 4 §5).
 *
 * ## Why this is its own service rather than a wider `listOrgs`
 *
 * The directory answers "show me every org" and has to stay one query over a
 * page of a hundred rows. This answers "tell me everything about THIS org",
 * which is six reads and an entitlement resolution — fine for one row, and
 * ruinous multiplied by a page. Two questions, two shapes.
 *
 * ## It reads through TWO scopes, deliberately
 *
 * `withPlatformAdminScope` for the org row and its memberships — the operator
 * role's permissive policies (0035) are what let it see another tenant at all.
 *
 * `withOrgScope` for the tenant-owned data: resolved entitlements and the
 * telephony spend ledger. Those go through the ORDINARY application role, on
 * the ordinary RLS path, because they are the same reads the org's own owner
 * performs — and routing them through the privileged role would mean a second
 * code path for the same question, which is the drift `packages/policy`'s own
 * "never re-derive authorization" note warns about. The operator's extra
 * capability is reaching this org at all, not seeing different data once here.
 */

export interface OrgMemberRow {
  readonly userId: string;
  readonly email: string;
  /** From people.profiles, lazily created — null for anyone who never set one. */
  readonly name: string | null;
  readonly role: string;
  readonly status: string;
  readonly joinedAt: Date;
}

export interface OrgFeatureRow {
  readonly flagName: string;
  readonly description: string;
  readonly enabled: boolean;
  /**
   * WHERE the answer came from.
   *
   * The whole reason an operator override is tolerable at all. "Docs: on"
   * with no provenance makes "why does this Free org have Docs?" unanswerable
   * — and a tier-1 override that outranks the plan guarantees that question
   * gets asked. `plan` and `override` are org-relative; `default` means no
   * org tier had an opinion and the global evaluator decided.
   */
  readonly source: 'plan' | 'override' | 'default';
}

export interface OrgDetail {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly createdAt: Date;

  readonly planId: string | null;
  readonly planName: string | null;
  readonly billingStatus: string;
  readonly trialEndsAt: Date | null;
  readonly billingGraceEndsAt: Date | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;

  /** The tier-1 override, when one is live. Null when absent OR expired. */
  readonly override: {
    readonly featuresAdd: readonly string[];
    readonly featuresRemove: readonly string[];
    readonly reason: string;
    readonly expiresAt: Date | null;
    readonly setAt: Date;
  } | null;

  readonly features: readonly OrgFeatureRow[];

  /** Resolved ceilings — null is unlimited, 0 is none-at-all. */
  readonly limits: {
    readonly telephonyCapCents: number | null;
    readonly automationRunsPerHour: number | null;
    readonly turnIssuancePerDay: number | null;
  };

  /**
   * Telephony spend over the SAME rolling 30-day window the gate uses, as
   * `COALESCE(actual, estimated)` — never `SUM(actual)`.
   *
   * The reasoning is `checkOutboundAllowed`'s own: a ledger row the carrier
   * has not billed yet has a NULL `actual_cents`, so summing that column alone
   * counts every in-flight action as free. A console showing a smaller number
   * than the gate enforces against is worse than showing none.
   */
  readonly telephonySpendCents: number;

  readonly members: readonly OrgMemberRow[];
  readonly memberCount: number;

  /**
   * The org's recorded invoices, newest first (migration 0065).
   *
   * Read through the OPERATOR role rather than `withOrgScope`, unlike the
   * entitlements and spend above — 0065 grants `taskflow_platform_admin`
   * SELECT and a permissive read policy for exactly this, because an operator
   * answering "did this customer actually pay" should not have to open a
   * tenant scope to find out.
   *
   * Bounded at twelve: the drill-down is a triage panel, not a ledger. The
   * customer's own Billing page is where a full history belongs.
   */
  readonly invoices: readonly {
    readonly providerInvoiceId: string;
    readonly number: string | null;
    readonly status: string;
    readonly amountDueCents: number;
    readonly currency: string;
    readonly hostedInvoiceUrl: string | null;
    readonly issuedAt: Date;
  }[];
}

/** The window `comms.spend_policy.window_days` defaults to, and the gate's own. */
const SPEND_WINDOW_DAYS = 30;

export async function getOrgDetail(operator: PlatformOperator, orgId: OrgId): Promise<OrgDetail> {
  const base = await withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select({
        orgId: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        status: schema.orgs.status,
        createdAt: schema.orgs.createdAt,
        planId: schema.orgs.planId,
        billingStatus: schema.orgs.billingStatus,
        trialEndsAt: schema.orgs.trialEndsAt,
        billingGraceEndsAt: schema.orgs.billingGraceEndsAt,
        stripeCustomerId: schema.orgs.stripeCustomerId,
        stripeSubscriptionId: schema.orgs.stripeSubscriptionId,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const org = rows[0];
    if (!org) throw errors.notFound();

    const members = await tx
      .select({
        userId: schema.memberships.userId,
        email: schema.users.email,
        name: coalesceColumns(schema.profiles.displayName, schema.users.displayName),
        role: schema.memberships.role,
        status: schema.memberships.status,
        joinedAt: schema.memberships.createdAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      /* LEFT — a profile row is lazy; an inner join would drop members who
         have never opened the account page, which is most of a seeded org. */
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
      .where(eq(schema.memberships.orgId, orgId))
      /* Owner first, then admins, then the rest — an operator opening this
         panel is nearly always looking for someone to contact. */
      .orderBy(schema.memberships.role, schema.users.email);

    /* The plan's display name. Read here rather than joined above because
       `plan_id` is nullable and a LEFT JOIN would make every column of the
       org row nullable in the inferred type for one string. */
    const planRows =
      org.planId === null
        ? []
        : await tx
            .select({ name: schema.plans.name })
            .from(schema.plans)
            .where(eq(schema.plans.id, org.planId))
            .limit(1);

    /* Twelve, newest first. The permissive read policy 0065 adds for this
       role is what makes this reachable without an org scope. */
    const invoices = await tx
      .select({
        providerInvoiceId: schema.invoices.providerInvoiceId,
        number: schema.invoices.number,
        status: schema.invoices.status,
        amountDueCents: schema.invoices.amountDueCents,
        currency: schema.invoices.currency,
        hostedInvoiceUrl: schema.invoices.hostedInvoiceUrl,
        issuedAt: schema.invoices.issuedAt,
      })
      .from(schema.invoices)
      .where(eq(schema.invoices.orgId, orgId))
      .orderBy(desc(schema.invoices.issuedAt))
      .limit(12);

    return { org, members, invoices, planName: planRows[0]?.name ?? null };
  });

  /* Tenant-owned reads, on the ordinary path. See the file header. */
  const [entitlements, flags, override, spend] = await Promise.all([
    getEntitlements(orgId),
    getFeatureFlags(),
    readOverride(orgId),
    readTelephonySpend(orgId),
  ]);

  const features: OrgFeatureRow[] = FLAG_NAMES.filter((name) => FLAGS[name].perOrg).map((name) => ({
    flagName: name,
    description: FLAGS[name].description,
    enabled: flags.isEnabled(name, { orgOverrides: entitlements.features }),
    source: entitlements.sources[name] ?? ('default' as const),
  }));

  await recordOperatorAction(operator.userId, 'orgs.detail', { orgId });

  return {
    ...base.org,
    planName: base.planName,
    override,
    features,
    limits: {
      telephonyCapCents: entitlements.limits.telephonyCapCents ?? null,
      automationRunsPerHour: entitlements.limits.automationRunsPerHour ?? null,
      turnIssuancePerDay: entitlements.limits.turnIssuancePerDay ?? null,
    },
    telephonySpendCents: spend,
    invoices: base.invoices,
    members: base.members,
    memberCount: base.members.filter((member) => member.status === 'active').length,
  };
}

/**
 * The live override row, or null.
 *
 * An EXPIRED row reads as null here, matching the resolver exactly — the
 * console must not display a grant that is no longer being applied, which is
 * precisely the confusion `expires_at` exists to create if the two disagree.
 */
async function readOverride(orgId: OrgId): Promise<OrgDetail['override']> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.orgEntitlements)
      .where(eq(schema.orgEntitlements.orgId, orgId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null;

    return {
      featuresAdd: row.featuresAdd,
      featuresRemove: row.featuresRemove,
      reason: row.reason,
      expiresAt: row.expiresAt,
      setAt: row.setAt,
    };
  });
}

async function readTelephonySpend(orgId: OrgId): Promise<number> {
  const since = new Date(Date.now() - SPEND_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        /* COALESCE(actual, estimated), summed — see the field's own comment.
           Returned as TEXT because a Postgres bigint sum exceeds a safe
           JavaScript number, so the parse is explicit. */
        total: sumWithFallback(schema.spendLedger.actualCents, schema.spendLedger.estimatedCents),
      })
      .from(schema.spendLedger)
      .where(and(eq(schema.spendLedger.orgId, orgId), gte(schema.spendLedger.occurredAt, since)));

    return Number(rows[0]?.total ?? 0);
  });
}

/**
 * One user, in full — the Users tab's drill-down.
 *
 * The directory could say a person belongs to N orgs and never WHICH, or with
 * what role, which made the count the least useful number on the page: an
 * operator handling "why can't this person see anything" needs the membership
 * row, not its cardinality.
 *
 * Read entirely through `withPlatformAdminScope`. A person belongs to several
 * orgs or to none, so there is no single org scope this could run under —
 * exactly the reason `userSuspended` carries SYSTEM_ORG rather than a tenant
 * envelope (see `platform-admin/events.ts`).
 */
export interface UserDetail {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly status: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly memberships: readonly {
    readonly orgId: string;
    readonly orgName: string;
    readonly orgSlug: string;
    readonly role: string;
    readonly status: string;
    readonly joinedAt: Date;
    /** The org's own state, so an operator sees "member of a suspended org" at a glance. */
    readonly orgStatus: string;
    readonly orgBillingStatus: string;
  }[];
}

export async function getUserDetail(
  operator: PlatformOperator,
  userId: UserId,
): Promise<UserDetail> {
  const detail = await withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        /* LEFT — a profile row is lazily created (see user-directory's own
           note); an inner join would drop exactly the accounts that have
           never been used, which is the population an operator most often
           opens this panel for. */
        name: coalesceColumns(schema.profiles.displayName, schema.users.displayName),
        status: schema.users.status,
        emailVerifiedAt: schema.users.emailVerifiedAt,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.users.id))
      .where(eq(schema.users.id, userId))
      .limit(1);

    const user = rows[0];
    if (!user) throw errors.notFound();

    const memberships = await tx
      .select({
        orgId: schema.orgs.id,
        orgName: schema.orgs.name,
        orgSlug: schema.orgs.slug,
        role: schema.memberships.role,
        status: schema.memberships.status,
        joinedAt: schema.memberships.createdAt,
        orgStatus: schema.orgs.status,
        orgBillingStatus: schema.orgs.billingStatus,
      })
      .from(schema.memberships)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.memberships.orgId))
      .where(eq(schema.memberships.userId, userId))
      .orderBy(schema.orgs.name);

    return { ...user, memberships };
  });

  await recordOperatorAction(operator.userId, 'users.detail', { userId });

  return detail;
}

/**
 * The operator audit chain, filtered to one org.
 *
 * Reads the GLOBAL chain and filters on the `target` JSON rather than keeping
 * a per-org copy: the chain is the record of what an OPERATOR did, and a
 * second store keyed by org would be a second thing to keep in step with a
 * hash chain that is deliberately append-only. Small enough to filter in the
 * query — an org accumulates operator actions at human speed.
 */
export async function getOrgOperatorHistory(
  operator: PlatformOperator,
  orgId: OrgId,
  limit: number,
): Promise<readonly { readonly action: string; readonly at: Date; readonly by: string }[]> {
  const rows = await withPlatformAdminScope(async (tx) =>
    tx
      .select({
        action: schema.operatorAuditLog.action,
        at: schema.operatorAuditLog.occurredAt,
        by: schema.users.email,
        target: schema.operatorAuditLog.target,
      })
      .from(schema.operatorAuditLog)
      .innerJoin(schema.users, eq(schema.users.id, schema.operatorAuditLog.operatorId))
      .orderBy(desc(schema.operatorAuditLog.seq))
      /* Over-fetch and filter in memory: `target` is jsonb and an index on
         `target->>'orgId'` does not exist. Bounded hard so this can never
         become a table scan disguised as a console panel. */
      .limit(500),
  );

  await recordOperatorAction(operator.userId, 'orgs.history', { orgId });

  return rows
    .filter((row) => (row.target as { orgId?: string } | null)?.orgId === orgId)
    .slice(0, limit)
    .map((row) => ({ action: row.action, at: row.at, by: row.by }));
}
