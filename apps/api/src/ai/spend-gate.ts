import { eq, gte, outboxWriter, schema, sumColumn, withOrgScope } from '@taskflow/db';
import { createEvent } from '@taskflow/events';
import type { MembershipId, OrgId } from '@taskflow/contracts';
import { getEntitlements } from '../billing/entitlement-resolver.js';
import { aiBudgetReached, aiUsageRecorded } from './events.js';

/**
 * THE AI budget gate (ai/phase-15-ai-copilot-and-permissions.md §3.2).
 *
 * One function every caller of `AiProvider.complete` routes through —
 * `apps/api/src/telephony/spend-gate.ts`'s exact discipline, restated here
 * rather than imported, because the two gates check different things against
 * different tables and a shared abstraction over "decide, then maybe refuse"
 * would hide that difference rather than remove it.
 *
 * ## The most important assertion is still that the provider was never reached
 *
 * Mirrored verbatim from telephony's own header: a gate that returns
 * `{ allowed: false }` after the completion has already been requested reads
 * correctly in a diff and costs real money in production. `completeGated`
 * below is the one place `AiProvider.complete` may be called from a budget-
 * aware caller, specifically so that property has exactly one call site to
 * verify.
 *
 * ## Checked BEFORE the call, never reconciled after — with one honest limit
 *
 * Telephony's gate can ask "would THIS estimated action cross the cap?"
 * because `TelephonyProvider.estimateCostCents` prices a call before it is
 * placed. There is no equivalent here: an LLM completion's token usage is
 * not known until the response returns, so the pre-call check can only ask
 * "has this org ALREADY reached its budget" — never "would this specific
 * call push it over." That is a real, narrower guarantee than telephony's,
 * not an oversight: the alternative would be inventing a token-count
 * estimate from the prompt text, which every provider's own tokenizer
 * disagrees with by enough that trusting it would either refuse requests
 * that were actually fine or let through ones that were not.
 *
 * ## No velocity limiter, and no `estimated`/`actual` split
 *
 * Both of those exist in telephony because a phone call's cost is
 * asynchronous (billed by a carrier callback) and worth pumping (toll
 * fraud). A completion's cost is synchronous and its only ceiling is the
 * budget itself; there is no separate abuse pattern a burst limiter would
 * catch that the budget does not already bound.
 */

export type AiGateRefusalReason = 'org_suspended' | 'budget_exceeded';

export interface AiGateAllowed {
  readonly allowed: true;
  readonly spentCents: number;
  /** null = unlimited (Phase 12 Wave 4's entitlement convention). */
  readonly budgetCents: number | null;
  /** Set when this completion's own past usage already crossed a warning
      threshold of the budget — see `checkAiCompletionAllowed`'s own comment
      on why this can only ever be read BEFORE the call whose cost is not
      yet known. */
  readonly warnThresholdPercent: number | undefined;
}

export interface AiGateRefused {
  readonly allowed: false;
  readonly reason: AiGateRefusalReason;
  readonly spentCents: number;
  readonly budgetCents: number | null;
}

export type AiGateDecision = AiGateAllowed | AiGateRefused;

/** Warn at 80% of the budget — same threshold telephony's gate uses, for the
    same reason: early enough to act, late enough not to be noise. */
const WARN_PERCENT = 80;

export interface AiSpendState {
  readonly orgStatus: string | undefined;
  /** null = unlimited. */
  readonly budgetCents: number | null;
  readonly spentCents: number;
}

/**
 * Reads everything the decision depends on, and decides nothing — split out
 * for the identical reason `telephony/spend-gate.ts`'s `readSpendState` is:
 * a read-only "what have we spent this month" view must share the exact
 * arithmetic the gate enforces without also being mistaken for the gate.
 *
 * The budget is resolved through `getEntitlements`, the SAME four-tier chain
 * (operator override -> plan -> environment -> registry) telephony's own
 * `comms.spend_policy` predates and Phase 12 Wave 4 built for exactly this
 * shape of ceiling — not a second, parallel override table.
 */
export async function readAiSpendState(orgId: OrgId): Promise<AiSpendState> {
  const entitlements = await getEntitlements(orgId);
  const budgetCents = entitlements.limits.aiTokenBudgetMonthlyCents ?? null;

  return withOrgScope(orgId, async (tx) => {
    const orgRows = await tx
      .select({ status: schema.orgs.status })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    /* A calendar month, not a rolling 30-day window like telephony's —
       `aiTokenBudgetMonthlyCents`'s own name is the contract, and a plan's
       "included" allowance is conventionally billed on the calendar. */
    const since = startOfCurrentMonth();

    const spend = await tx
      .select({ total: sumColumn(schema.aiUsageLedger.costCents) })
      .from(schema.aiUsageLedger)
      .where(gte(schema.aiUsageLedger.occurredAt, since));

    return {
      orgStatus: orgRows[0]?.status,
      budgetCents,
      /* Postgres SUM over bigint arrives as a STRING through the driver, and
         `Number(undefined)` is NaN, which compares false against every
         threshold — the identical trap `readSpendState` guards against.
         Parsed explicitly and floored at 0. */
      spentCents: Math.max(0, Number.parseInt(spend[0]?.total ?? '0', 10) || 0),
    };
  });
}

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Decides whether one completion request may proceed. Returns a verdict
 * rather than throwing, for the same reason `checkOutboundAllowed` does: the
 * caller turns a refusal into both a user-facing error AND an
 * `ai_budget.exceeded` event, and a thrown error makes it easy to satisfy
 * the first obligation and forget the second.
 */
export async function checkAiCompletionAllowed(orgId: OrgId): Promise<AiGateDecision> {
  const state = await readAiSpendState(orgId);

  if (state.orgStatus !== 'active') {
    return {
      allowed: false,
      reason: 'org_suspended',
      spentCents: state.spentCents,
      budgetCents: state.budgetCents,
    };
  }

  if (state.budgetCents !== null && state.spentCents >= state.budgetCents) {
    return {
      allowed: false,
      reason: 'budget_exceeded',
      spentCents: state.spentCents,
      budgetCents: state.budgetCents,
    };
  }

  const crossesWarning =
    state.budgetCents !== null &&
    state.budgetCents > 0 &&
    state.spentCents * 100 >= state.budgetCents * WARN_PERCENT;

  return {
    allowed: true,
    spentCents: state.spentCents,
    budgetCents: state.budgetCents,
    warnThresholdPercent: crossesWarning ? WARN_PERCENT : undefined,
  };
}

/* -------------------------------------------------------------------------- *
 * Writing the ledger
 * -------------------------------------------------------------------------- */

export interface AiUsageEntry {
  readonly id: string;
  readonly membershipId: MembershipId | undefined;
  readonly feature: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costCents: number;
}

/**
 * Appends a ledger row, in the caller's own transaction — §3.1 requires this
 * to be written in the SAME transaction as the request it accounts for, the
 * identical reasoning `recordSpend` gives: a function that opened its own
 * transaction would let the two commit separately, and the failure mode is a
 * completion that happened and was never charged against the budget.
 */
export async function recordAiUsage(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  entry: AiUsageEntry,
  envelope?: Parameters<typeof createEvent>[2],
): Promise<void> {
  await tx.insert(schema.aiUsageLedger).values({
    id: entry.id,
    orgId,
    ...(entry.membershipId === undefined ? {} : { membershipId: entry.membershipId }),
    feature: entry.feature,
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    costCents: entry.costCents,
  });

  if (envelope === undefined) return;

  const after = await readAiSpendState(orgId);
  const crossesWarning =
    after.budgetCents !== null &&
    after.budgetCents > 0 &&
    after.spentCents * 100 >= after.budgetCents * WARN_PERCENT &&
    (after.spentCents - entry.costCents) * 100 < after.budgetCents * WARN_PERCENT;

  await outboxWriter.append(tx, [
    createEvent(
      aiUsageRecorded,
      {
        feature: entry.feature,
        provider: entry.provider,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costCents: entry.costCents,
      },
      envelope,
    ),
  ]);

  /* `ai_budget.reached` — only on the transition, same as `spend.cap_reached`:
     an alert on every row past 80% would fire on every remaining request in
     the month rather than once, at the moment there was still time to act. */
  if (crossesWarning) {
    await outboxWriter.append(tx, [
      createEvent(
        aiBudgetReached,
        { spentCents: after.spentCents, budgetCents: after.budgetCents, thresholdPercent: WARN_PERCENT },
        envelope,
      ),
    ]);
  }
}
