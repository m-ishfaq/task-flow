import { and, eq, gte, schema, sumWithFallback, withOrgScope } from '@taskflow/db';
import type {
  OrgId,
  OutboundKind,
  PhoneNumber,
  TelephonyRefusal,
  UserId,
} from '@taskflow/contracts';
import { checkDestination } from '@taskflow/telephony';
import { SlidingWindowLimiter, type RateLimitRule } from '../middleware/sliding-window.js';

/**
 * THE outbound gate (PLAN.md §8.5; ai/phase-7-voice.md §3.2, §3.3).
 *
 * ## One function, and why that is the whole design
 *
 * Exactly the discipline `can()` establishes for authorization: one decision
 * function that every caller routes through, so a second call site cannot
 * quietly re-implement the check slightly wrong. `placeCall`, `sendSms`,
 * `purchaseNumber` and `startVerification` all pass through here before any
 * `TelephonyProvider` method is reached — and Wave 1 ships this BEFORE any of
 * them exist, which is §3.2's build-order constraint rather than a stylistic
 * preference. A control retrofitted after the capability it should have gated
 * is the control most likely to have a hole nobody has looked for.
 *
 * Four separate checks live here rather than in four call sites for the reason
 * §3.3 gives: three checks in three places is three chances for one of them to
 * be forgotten on the next outbound path someone adds.
 *
 * ## Checked BEFORE the provider call, never reconciled after
 *
 * An after-the-fact reconciliation catches an overspend once it has already
 * happened, which is a report, not a control.
 *
 * ## The order of the checks is deliberate
 *
 *   1. **Geo** — pure, no database, and the most common refusal for a
 *      compromised account. A premium-rate destination is refused without a
 *      round trip.
 *   2. **Org freeze, subaccount, spend** — one transaction, three reads.
 *   3. **Velocity** — LAST, because it is the only check that MUTATES state.
 *      Counting an attempt that was going to be refused anyway would let an
 *      attacker burn a legitimate user's velocity budget with requests that
 *      cost nothing to refuse.
 */

/* -------------------------------------------------------------------------- *
 * Velocity
 * -------------------------------------------------------------------------- */

/**
 * Per-user and per-org burst limits (§3.3, "per-user and per-number velocity
 * limits").
 *
 * Reuses Phase 1's `SlidingWindowLimiter` rather than inventing a second
 * counter — including its documented limits, which matter more here than they
 * do for login: these counters live in THIS process, so a restart forgives
 * everyone and two instances give roughly twice the budget.
 *
 * That is acceptable only because velocity is not the durable control. The
 * spend ledger is: it lives in Postgres, survives a restart, and is shared
 * across instances. Velocity stops a burst inside one window; the cap stops the
 * bill. Reading this as the primary toll-fraud defence would be reading it
 * exactly backwards — the same relationship §8.9's per-IP limiter has to the
 * database-backed account lockout.
 */
const VELOCITY: Readonly<Record<OutboundKind, RateLimitRule>> = {
  /* A person clicks call-to-dial a few times a minute at most. Ten leaves room
     for a redial after a misdial without being a usable pumping rate. */
  call: { limit: 10, windowMs: 60_000 },
  sms: { limit: 30, windowMs: 60_000 },
  /* Buying numbers in a loop is not a thing a legitimate user does, and each
     one costs about a dollar. */
  number_purchase: { limit: 3, windowMs: 60 * 60_000 },
  /* Verification is the MFA fallback path (§3.12) and is the classic SMS-pumping
     target: an attacker triggers "send me a code" repeatedly against numbers
     they control a revenue share on. */
  verification: { limit: 5, windowMs: 15 * 60_000 },
};

/** Org-wide ceiling, so one compromised account cannot be laundered across many. */
const ORG_VELOCITY: RateLimitRule = { limit: 60, windowMs: 60_000 };

const limiter = new SlidingWindowLimiter();

/** Test isolation only — counters must not leak between cases. */
export function __resetVelocityForTests(): void {
  limiter.reset();
}

/* -------------------------------------------------------------------------- *
 * The decision
 * -------------------------------------------------------------------------- */

export interface OutboundRequest {
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly kind: OutboundKind;
  readonly to: PhoneNumber;
  /** From `TelephonyProvider.estimateCostCents`. Must be an over-estimate. */
  readonly estimatedCents: number;
}

export interface GateAllowed {
  readonly allowed: true;
  readonly subaccountSid: string;
  readonly spentCents: number;
  readonly capCents: number;
  /**
   * Set when this action takes the org past a warning threshold of its cap.
   *
   * The caller emits `spend.cap_reached` for it. Reported from here rather than
   * computed by the caller because the caller does not otherwise need to know
   * the cap, and a threshold recomputed at each call site drifts.
   */
  readonly warnThresholdPercent: number | undefined;
}

export interface GateRefused {
  readonly allowed: false;
  readonly reason: TelephonyRefusal;
  readonly spentCents: number;
  readonly capCents: number;
  readonly retryAfterSeconds: number | undefined;
}

export type GateDecision = GateAllowed | GateRefused;

/** Warn at 80% of the cap — early enough to act, late enough not to be noise. */
const WARN_PERCENT = 80;

export interface GateConfig {
  /** Applied to orgs with no explicit `comms.spend_policy` row. */
  readonly defaultCapCents: number;
}

export interface SpendState {
  readonly orgStatus: string | undefined;
  readonly subaccount: { readonly sid: string; readonly status: string } | undefined;
  readonly capCents: number;
  readonly spentCents: number;
}

/**
 * Reads everything the decision depends on, and decides nothing.
 *
 * Split out of `checkOutboundAllowed` so a "what have we spent?" surface can
 * share the exact arithmetic without also running the VELOCITY check — which
 * mutates. A read-only spend page that called the full gate would consume the
 * caller's own burst allowance every time it rendered, throttling their ability
 * to place calls by looking at a dashboard.
 *
 * One function rather than two queries in two places, for the reason `can()`
 * establishes for authorization: a second implementation of the arithmetic is a
 * second chance for the number a user SEES and the number the cap ENFORCES to
 * drift apart.
 */
export async function readSpendState(orgId: OrgId, config: GateConfig): Promise<SpendState> {
  return withOrgScope(orgId, async (tx) => {
    /* The org-freeze primitive (ai/phase-12-admin.md §9).
     *
     * `identity.orgs.status` has existed since migration 0004 and NOTHING has
     * ever read it. This is its first reader, and it is here rather than at the
     * HTTP layer for the reason that section spells out: suspension enforcement
     * elsewhere runs at request-authentication time, and telephony's real cost
     * risk lives on paths that never pass through it — an inbound webhook, a
     * queued send, an automation action. A check that only runs where a user is
     * waiting is not a kill switch.
     *
     * When Phase 12 Wave 1 lands, it sets this column from its console and
     * subscribes nothing here; adopting it is a swap, not a redesign. */
    const orgRows = await tx
      .select({ status: schema.orgs.status })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const accountRows = await tx
      .select({ sid: schema.subaccounts.subaccountSid, status: schema.subaccounts.status })
      .from(schema.subaccounts)
      .limit(1);

    const policyRows = await tx
      .select({ capCents: schema.spendPolicy.capCents, windowDays: schema.spendPolicy.windowDays })
      .from(schema.spendPolicy)
      .limit(1);

    const capCents = policyRows[0]?.capCents ?? config.defaultCapCents;
    const windowDays = policyRows[0]?.windowDays ?? 30;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    /* `sumWithFallback` — COALESCE(actual, estimated), not SUM(actual).
     *
     * A row the carrier has not billed yet has a NULL `actual_cents`, and
     * summing that column alone counts every in-flight action as free — which
     * is precisely the window an attacker exploits by going faster than
     * reconciliation. The conservative estimate stands in until the real figure
     * arrives. Named in `packages/db/expressions.ts` because raw `sql` is
     * banned here (guardrail 7), and the answer to that ban is a named
     * expression rather than an exemption. */
    const spend = await tx
      .select({
        total: sumWithFallback(schema.spendLedger.actualCents, schema.spendLedger.estimatedCents),
      })
      .from(schema.spendLedger)
      .where(gte(schema.spendLedger.occurredAt, since));

    return {
      orgStatus: orgRows[0]?.status,
      subaccount: accountRows[0],
      capCents,
      /* Postgres SUM over bigint comes back as a STRING through the driver, and
         `Number(undefined)` is NaN — which compares false against every
         threshold, so a parsing slip here reads as "under the cap" forever.
         Parsed explicitly and floored at 0. */
      spentCents: Math.max(0, Number.parseInt(spend[0]?.total ?? '0', 10) || 0),
    };
  });
}

/**
 * Decides whether one outbound action may proceed.
 *
 * Returns a verdict rather than throwing. The caller turns a refusal into a
 * `QUOTA_EXCEEDED` error AND a `spend.limit_exceeded` event, and those two are
 * different obligations — a thrown error would make it easy to satisfy the
 * first and forget the second, which is exactly the "the system quietly stopped
 * placing calls" outcome §4 argues against.
 */
export async function checkOutboundAllowed(
  request: OutboundRequest,
  config: GateConfig,
): Promise<GateDecision> {
  /* --- 1. Geo (pure) ----------------------------------------------------- */
  if (!checkDestination(request.to).allowed) {
    return {
      allowed: false,
      reason: 'destination_not_allowed',
      spentCents: 0,
      capCents: 0,
      /* No retry-after. A denied destination is not a temporary condition, and
         suggesting a retry invites a client to poll a control that will never
         change its mind. */
      retryAfterSeconds: undefined,
    };
  }

  /* --- 2. Org freeze, subaccount, rolling spend (one transaction) -------- */
  const state = await readSpendState(request.orgId, config);

  if (state.orgStatus !== 'active') {
    return {
      allowed: false,
      reason: 'org_suspended',
      spentCents: state.spentCents,
      capCents: state.capCents,
      retryAfterSeconds: undefined,
    };
  }

  if (state.subaccount?.status !== 'active') {
    return {
      allowed: false,
      reason: 'no_subaccount',
      spentCents: state.spentCents,
      capCents: state.capCents,
      retryAfterSeconds: undefined,
    };
  }

  /* `>` would let the action that crosses the cap through — the cap would be a
     line the org is permitted to step over exactly once, for an amount the
     caller chooses. */
  if (state.spentCents + request.estimatedCents > state.capCents) {
    return {
      allowed: false,
      reason: 'spend_cap_exceeded',
      spentCents: state.spentCents,
      capCents: state.capCents,
      retryAfterSeconds: undefined,
    };
  }

  /* --- 3. Velocity (mutates, so it runs last) ---------------------------- */
  const perUser = limiter.check(
    `tel:${request.orgId}:${request.userId}:${request.kind}`,
    VELOCITY[request.kind],
  );
  if (!perUser.allowed) {
    return {
      allowed: false,
      reason: 'velocity_exceeded',
      spentCents: state.spentCents,
      capCents: state.capCents,
      retryAfterSeconds: perUser.retryAfterSeconds,
    };
  }

  const perOrg = limiter.check(`tel:${request.orgId}`, ORG_VELOCITY);
  if (!perOrg.allowed) {
    return {
      allowed: false,
      reason: 'velocity_exceeded',
      spentCents: state.spentCents,
      capCents: state.capCents,
      retryAfterSeconds: perOrg.retryAfterSeconds,
    };
  }

  const after = state.spentCents + request.estimatedCents;
  const crossesWarning =
    state.capCents > 0 &&
    after * 100 >= state.capCents * WARN_PERCENT &&
    state.spentCents * 100 < state.capCents * WARN_PERCENT;

  return {
    allowed: true,
    subaccountSid: state.subaccount.sid,
    spentCents: state.spentCents,
    capCents: state.capCents,
    warnThresholdPercent: crossesWarning ? WARN_PERCENT : undefined,
  };
}

/* -------------------------------------------------------------------------- *
 * Writing the ledger
 * -------------------------------------------------------------------------- */

export interface SpendEntry {
  readonly id: string;
  readonly kind: OutboundKind;
  readonly estimatedCents: number;
  readonly providerSid: string | undefined;
}

/**
 * Appends a ledger row.
 *
 * Takes a transaction rather than opening one, because §3.4 requires this to be
 * written in the SAME transaction as the record of the action it prices. A
 * function that opened its own would make the two commit separately, and the
 * failure mode is a call that happened and was never charged against the cap.
 */
export async function recordSpend(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  entry: SpendEntry,
): Promise<void> {
  await tx.insert(schema.spendLedger).values({
    id: entry.id,
    orgId,
    kind: entry.kind,
    estimatedCents: entry.estimatedCents,
    ...(entry.providerSid === undefined ? {} : { providerSid: entry.providerSid }),
  });
}

/**
 * Corrects a ledger row once the carrier reports what it actually charged.
 *
 * Matched on `provider_sid`, which is UNIQUE per org (migration 0032), so a
 * retried billing callback updates the one row rather than appending a second
 * charge for the same call.
 */
export async function reconcileSpend(
  orgId: OrgId,
  providerSid: string,
  actualCents: number,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx
      .update(schema.spendLedger)
      .set({ actualCents })
      .where(
        and(eq(schema.spendLedger.orgId, orgId), eq(schema.spendLedger.providerSid, providerSid)),
      );
  });
}
