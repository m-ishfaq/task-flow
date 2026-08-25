import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Platform-admin domain events — guardrail 11 (PLAN.md §2.1;
 * ai/phase-12-admin.md §4).
 *
 * Four events, three of them the wave's own catalog and the fourth a
 * deliberate extension of it: `platform.flag_override_set` is not in the spec's
 * list of four, but guardrail 11 is non-negotiable and `flags.set` is a state
 * mutation — a typed event is what the rule requires, and flag governance is
 * exactly the kind of fact this system's audit log exists to answer.
 *
 * ## Delivery: the EventBus, not the outbox
 *
 * These events are published through the in-process `EventBus` dependency,
 * the identical path people's `profile.updated` uses, for the identical
 * structural reason: `platform.outbox`'s RLS policy is `org_id = app.org_id`
 * on WITH CHECK (migration 0006), and the role that performs these mutations
 * is `taskflow_platform_admin` — which holds no grant on the outbox and whose
 * writes happen with no org scope at all. The outbox cannot hold them. The
 * durable, chained records of these actions are the TWO audit writes the
 * services themselves perform (§4, decision 2 option (c)): the target org's
 * own `audit.audit_log` chain for org-scoped actions, and the global
 * `platform.operator_audit_log` for every action. The published event is what
 * a future in-process consumer (Phase 7's org-freeze fast path, §9) subscribes
 * to.
 */

/**
 * An organization was suspended by a platform operator.
 *
 * The target org's own audit chain is written directly by the suspending
 * service (§4, decision 2 option (c)) — an Owner sees \"a platform operator
 * suspended this org\" in their own audit history with no operator access
 * required. The event itself carries the operator id so a subscriber (Phase
 * 7's org-freeze check) never has to correlate.
 */
export const orgSuspended = defineEvent(
  'platform.org_suspended',
  z.object({ orgId: z.string(), operatorUserId: z.string() }).strict(),
);

/** The inverse of `orgSuspended` — an operator restored the org. */
export const orgReactivated = defineEvent(
  'platform.org_reactivated',
  z.object({ orgId: z.string(), operatorUserId: z.string() }).strict(),
);

/**
 * Someone became a platform operator (§4).
 *
 * Wave 1 ships no self-service route for this (§7 decision 7: migration or
 * one-off script only), so in practice this event's only producer is a
 * migration/seed script — still worth a real definition rather than an
 * unaudited manual INSERT, because \"who has platform-operator access and
 * since when\" is exactly the question this system's audit log exists to
 * answer.
 */
export const operatorGranted = defineEvent(
  'platform.operator_granted',
  z.object({ userId: z.string(), grantedBy: z.string() }).strict(),
);

/**
 * A global feature-flag override was set, cleared, or changed (§3.8).
 *
 * Not in the spec's four-event catalog — added because guardrail 11 demands a
 * typed event for every state mutation and `flags.set` is one. Global, like
 * the table it records: the envelope carries SYSTEM_ORG, the same sentinel
 * people's `profile.updated` uses for a fact true of the person in every org.
 */
export const flagOverrideSet = defineEvent(
  'platform.flag_override_set',
  z
    .object({ flagName: z.string(), value: z.boolean().nullable(), operatorUserId: z.string() })
    .strict(),
);

/**
 * A global feature-flag override was REMOVED, so the flag falls back to its
 * compiled default (§3.8).
 *
 * Its own event rather than `flagOverrideSet` with a null value, even though
 * one route (`flags.set`) produces both. "The override now says false" and
 * "there is no longer an override" are different facts with different
 * consequences — the first pins behaviour against a later default change,
 * the second releases it — and a reader reconstructing why a flag behaved a
 * certain way on a given day cannot tell them apart from a null payload
 * alone. The route surface stays single; only the record distinguishes.
 */
export const flagOverrideCleared = defineEvent(
  'platform.flag_override_cleared',
  z.object({ flagName: z.string(), operatorUserId: z.string() }).strict(),
);

/**
 * The deployment's branding changed — product name, logo, favicon, or
 * accent palette (migration 0073).
 *
 * Global, like `flagOverrideSet`: the envelope carries SYSTEM_ORG, because
 * there is exactly one branding row for the whole platform and no target
 * org's own chain to write instead. The payload carries only WHICH fields
 * changed, not the new values themselves — the values are already durable
 * in `platform.branding`, and `platform.operator_audit_log`'s own `target`
 * column (via `recordOperatorAction`) is where the actual before/after
 * belongs, the same split `flags.set` uses between this event and its
 * audit-log target.
 */
export const brandingUpdated = defineEvent(
  'platform.branding_updated',
  z
    .object({
      operatorUserId: z.string(),
      fields: z.array(z.enum(['productName', 'logoKey', 'faviconKey', 'paletteId'])),
    })
    .strict(),
);

/**
 * An org was deleted by a platform operator (Phase 12 Wave 2 §3.5).
 *
 * SYSTEM_ORG on the envelope, not the org's own id: by the time this event
 * publishes, the org row is gone — its outbox, its audit chain, and its
 * product data all deleted with it — and the outbox envelope's
 * `NOT NULL REFERENCES identity.orgs` could not point at a row that no
 * longer exists even if the role held a grant on the outbox (it does not).
 * The one durable record of the deletion is the `orgs.delete` entry in
 * `platform.operator_audit_log`, written before this event, carrying the
 * same org id, slug, member count, and the confirmation slug the operator
 * typed.
 */
export const orgDeleted = defineEvent(
  'platform.org_deleted',
  z
    .object({
      orgId: z.string(),
      slug: z.string(),
      operatorUserId: z.string(),
      memberCount: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * An account was suspended by a platform operator (Phase 12 Wave 2 §3.1,
 * ai/phase-12-wave2.md).
 *
 * SYSTEM_ORG on the envelope, unlike `orgSuspended` above, and the difference
 * is not cosmetic: a suspended ORG has exactly one audit chain that the action
 * belongs in, so `suspendOrg` writes the target org's own `audit.audit_log`
 * alongside the operator chain. A suspended PERSON may belong to several orgs
 * or to none, so there is no single tenant chain to write into and no honest
 * way to pick one — the durable record is the global
 * `platform.operator_audit_log` alone.
 */
export const userSuspended = defineEvent(
  'platform.user_suspended',
  z.object({ userId: z.string(), operatorUserId: z.string() }).strict(),
);

/** The inverse of `userSuspended` — an operator restored the account. */
export const userReactivated = defineEvent(
  'platform.user_reactivated',
  z.object({ userId: z.string(), operatorUserId: z.string() }).strict(),
);

/* -------------------------------------------------------------------------- *
 * The plan catalog (Phase 12 Wave 4, ai/phase-12-wave4-plans.md §4)
 *
 * All SYSTEM_ORG on the envelope, for the reason `flagOverrideSet` gives and
 * more strongly: a plan belongs to no tenant. It is the thing tenants are on.
 * -------------------------------------------------------------------------- */

/** A new plan exists in the catalog, with its processor product already made. */
export const planCreated = defineEvent(
  'platform.plan_created',
  z
    .object({
      planId: z.string(),
      name: z.string(),
      stripeProductId: z.string().nullable(),
      operatorUserId: z.string(),
    })
    .strict(),
);

/**
 * A plan's metadata, feature set or ceilings changed.
 *
 * `changed` is the list of column names, not the values. The values are in the
 * operator audit chain's `target`, which is the durable, hash-chained record;
 * duplicating them onto the bus would mean two records of the same fact that
 * can disagree, and the one a subscriber reads is the one nobody verifies.
 */
export const planUpdated = defineEvent(
  'platform.plan_updated',
  z
    .object({
      planId: z.string(),
      changed: z.array(z.string()).readonly(),
      operatorUserId: z.string(),
    })
    .strict(),
);

/**
 * A plan was repriced: a new price is current and the previous one is retired.
 *
 * `grandfatheredOrgs` is the count still billing against the retired price —
 * the number that makes this event worth having. A subscriber (and the
 * console) can answer "how many customers did that decision leave behind"
 * without reconstructing it from two tables later, when the answer has moved.
 */
export const planPriceChanged = defineEvent(
  'platform.plan_price_changed',
  z
    .object({
      planId: z.string(),
      interval: z.enum(['month', 'year']),
      previousAmountCents: z.number().int().nonnegative().nullable(),
      amountCents: z.number().int().nonnegative(),
      currency: z.string(),
      grandfatheredOrgs: z.number().int().nonnegative(),
      operatorUserId: z.string(),
    })
    .strict(),
);

/**
 * One org moved to a different plan.
 *
 * The ORG's own id on the envelope, unlike every other event in this block —
 * this is a fact about one tenant rather than about the catalog, and their own
 * audit history should carry it without needing operator access to read.
 *
 * `actor` distinguishes the three writers that will exist by the end of this
 * wave: an operator moving them by hand, the owner's own checkout, and the
 * trial sweep dropping them to the default plan. A consumer that cannot tell
 * those apart cannot tell a support action from an automated downgrade, which
 * is the first question anyone asks when access changes unexpectedly.
 */
export const orgPlanChanged = defineEvent(
  'platform.org_plan_changed',
  z
    .object({
      orgId: z.string(),
      from: z.string().nullable(),
      to: z.string(),
      actor: z.enum(['operator', 'owner', 'sweep']),
      operatorUserId: z.string().nullable(),
    })
    .strict(),
);

/**
 * An operator set or cleared one org's entitlement override — tier 1 of the
 * four-tier resolution (§3.1).
 *
 * The org's own id on the envelope, like `orgPlanChanged`: this is a fact
 * about one tenant. `cleared` distinguishes "the override now grants nothing"
 * from "there is no longer an override" — the same distinction
 * `flagOverrideCleared` exists for, and it matters for the same reason: the
 * first pins behaviour against a later plan change, the second releases it.
 */
export const orgEntitlementOverrideSet = defineEvent(
  'platform.org_entitlement_override_set',
  z
    .object({
      orgId: z.string(),
      featuresAdd: z.array(z.string()).readonly(),
      featuresRemove: z.array(z.string()).readonly(),
      cleared: z.boolean(),
      reason: z.string(),
      expiresAt: z.string().nullable(),
      operatorUserId: z.string(),
    })
    .strict(),
);

/**
 * A plan was retired from sale.
 *
 * `orgsRemaining` is not decoration: retiring a tier must never eject its
 * tenants (they keep the plan and keep working), so a non-zero count here is
 * the normal case and the number an operator needs in order to plan a
 * migration. A zero-count archive is the clean one.
 */
export const planArchived = defineEvent(
  'platform.plan_archived',
  z
    .object({
      planId: z.string(),
      orgsRemaining: z.number().int().nonnegative(),
      operatorUserId: z.string(),
    })
    .strict(),
);

/**
 * An operator sent a broadcast notification to a specific member, a
 * role-filtered subset, or every active member of one org.
 *
 * This is NOT what delivers the notification — `broadcast.service.ts` writes
 * `platform.notifications`/`notification_deliveries` directly, reusing the
 * existing push/email drains, for the same reason every other write in this
 * file bypasses the outbox: `taskflow_platform_admin` holds no grant on it.
 * This event is the guardrail-11 record of the ACTION, for a future
 * subscriber (an analytics rollup, an abuse-pattern alert), not the delivery
 * mechanism. It also means an operator broadcast does NOT get the instant
 * `apps/realtime` live push ordinary notifications get — that fan-out is
 * driven by the outbox consumer specifically (`notification.projection.ts`'s
 * `notificationCreated`, appended via `outboxWriter` inside the SAME
 * transaction as the insert), a path this role cannot reach either. The
 * in-app row still appears on next load/poll, and push/email still deliver
 * on their own schedule — only the sub-second live-tab update is the gap,
 * accepted rather than routed around by widening this role's grants.
 */
export const operatorBroadcastSent = defineEvent(
  'platform.operator_broadcast_sent',
  z
    .object({
      broadcastId: z.string(),
      orgId: z.string(),
      audienceTarget: z.enum(['all', 'role', 'users']),
      recipientCount: z.number().int().nonnegative(),
      operatorUserId: z.string(),
    })
    .strict(),
);
