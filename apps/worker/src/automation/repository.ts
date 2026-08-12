import { and, consumeAutomationBudget, eq, schema, withOrgScope } from '@taskflow/db';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';
import { FilterTree, resourceForTrigger, validate, type FilterNode } from '@taskflow/filter';
import type { AutomationAction, AutomationRule, RunOutcome } from './types.js';

/**
 * The engine's database access — everything it does as `taskflow_app` inside
 * `withOrgScope`.
 *
 * Nothing here runs on the claim connection. `taskflow_automation` holds no
 * grant on any of these tables (migration 0047, proved by
 * `packages/db/src/automation-grants.test.ts`), so the role that finds the work
 * cannot read a rule, record a run, or move a budget. That separation is the
 * reason this file exists as its own module rather than inline in the relay.
 */

/** The per-org hourly execution budget — loop protection's layer 3. */
export const HOURLY_EXECUTION_BUDGET = 1_000;

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * Every enabled rule in this org listening for this event.
 *
 * A disabled rule is filtered in SQL rather than loaded and skipped, because
 * the common case for a disabled rule is that somebody turned it off to stop
 * it doing something — and loading it into a code path that could still run it
 * is a worse shape than not having it.
 *
 * The stored `condition` is re-parsed and re-validated HERE, not trusted: a
 * column is not a parser. A tree written by an older build, or edited by hand,
 * would otherwise reach `evaluate()` — which refuses unknown fields, so it
 * could not do anything dangerous, but it would surface as a thrown exception
 * inside the drain loop rather than as one broken rule. `condition: undefined`
 * marks it unusable, and the engine records `condition_unusable` against that
 * rule alone.
 */
export async function loadRulesFor(
  orgId: OrgId,
  triggerEvent: string,
): Promise<readonly (AutomationRule | UnusableRule)[]> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.automations.id,
        name: schema.automations.name,
        triggerEvent: schema.automations.triggerEvent,
        condition: schema.automations.condition,
        actions: schema.automations.actions,
        enabled: schema.automations.enabled,
        createdBy: schema.automations.createdBy,
      })
      .from(schema.automations)
      .where(
        and(
          eq(schema.automations.orgId, orgId),
          eq(schema.automations.triggerEvent, triggerEvent),
          eq(schema.automations.enabled, true),
        ),
      );

    return rows.map((row) => {
      const condition = parseStoredCondition(row.triggerEvent, row.condition);
      const actions = parseStoredActions(row.actions);

      if (condition === UNUSABLE || actions === null) {
        return { id: row.id, name: row.name, unusable: true as const };
      }

      return {
        id: row.id,
        orgId,
        name: row.name,
        triggerEvent: row.triggerEvent,
        condition,
        actions,
        enabled: row.enabled,
        createdBy: unsafeAsId<'UserId'>(row.createdBy),
      };
    });
  });
}

/** A rule whose stored shape no longer parses — reported, never executed. */
export interface UnusableRule {
  readonly id: string;
  readonly name: string;
  readonly unusable: true;
}

export function isUnusable(rule: AutomationRule | UnusableRule): rule is UnusableRule {
  return 'unusable' in rule;
}

const UNUSABLE = Symbol('unusable-condition');

function parseStoredCondition(
  triggerEvent: string,
  stored: unknown,
): FilterNode | null | typeof UNUSABLE {
  if (stored === null || stored === undefined) return null;

  const parsed = FilterTree.safeParse(stored);
  if (!parsed.success) return UNUSABLE;

  /* BOTH checks, and they are not the same check twice — the argument
     `view.service.ts` makes for saved views, verbatim. `FilterTree` validates
     SHAPE and cannot validate MEANING: it accepts a field name that no longer
     exists as readily as one that does, so a structurally perfect tree naming
     nothing would be called healthy right up until evaluation.

     The field set comes from the TRIGGER (§7.8b), matching what the API
     validated at save time. Hard-coding `'card'` here would mark every
     connector rule's condition unusable — refusing, in the worker, exactly the
     rules the API had just accepted. */
  return validate(resourceForTrigger(triggerEvent), parsed.data).ok ? parsed.data : UNUSABLE;
}

/**
 * Narrows the stored actions array.
 *
 * Shape only — that an entry has a string `type`. WHICH types are legal is the
 * executor's exhaustiveness check and the route's Zod schema; re-deciding it
 * here would be a third copy of the action catalog.
 */
function parseStoredActions(stored: unknown): readonly AutomationAction[] | null {
  if (!Array.isArray(stored) || stored.length === 0) return null;

  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) return null;
    if (typeof (entry as { type?: unknown }).type !== 'string') return null;
  }

  return stored as readonly AutomationAction[];
}

/**
 * Layer 3 of loop protection — the DURABLE per-org hourly budget.
 *
 * The statement itself lives in `packages/db/src/automation-budget.ts`, because
 * raw `sql` outside that package is a lint error and the answer to that ban is
 * a named function rather than an exemption. The guardrail caught this on its
 * first run, when the upsert was written inline here — see that file's header.
 *
 * Returns whether this execution was admitted. A refusal consumes nothing, so
 * a rule that is always refused cannot exhaust the allowance by being refused.
 */
export async function consumeExecutionBudget(orgId: OrgId): Promise<boolean> {
  return consumeAutomationBudget(orgId, HOURLY_EXECUTION_BUDGET);
}

/**
 * True when the org may run automations at all — the kill switch's org half.
 *
 * `identity.orgs.status` has been the system-wide freeze since migration 0004
 * and the notification sweeps have joined it since 0037. An automation engine
 * is precisely the background actor PLAN.md §8.5 had in mind: a kill switch
 * that only runs where a user is waiting is not a kill switch.
 */
export async function orgIsActive(orgId: OrgId): Promise<boolean> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ status: schema.orgs.status })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    return rows[0]?.status === 'active';
  });
}

/**
 * Records what happened, including when nothing did.
 *
 * A row is written for `skipped` too — the condition did not match — because
 * "my rule did not fire" is the single most common question a rules engine is
 * asked, and a history of successes cannot distinguish "the engine never saw
 * the event" from "it saw it and the condition said no".
 *
 * Append-only by GRANT: `taskflow_app` holds INSERT and SELECT here and no
 * UPDATE or DELETE (migration 0047's REVOKEs, asserted in
 * `automation-grants.test.ts`), so nothing can rewrite a run after the fact.
 */
export async function recordRun(
  orgId: OrgId,
  input: {
    readonly eventId: string;
    readonly triggerEvent: string;
    readonly outcome: RunOutcome;
  },
): Promise<void> {
  await withOrgScope(orgId, async (tx: Tx) => {
    await tx.insert(schema.automationRuns).values({
      id: newId(),
      orgId,
      automationId: input.outcome.automationId,
      eventId: input.eventId,
      triggerEvent: input.triggerEvent,
      status: input.outcome.status,
      ...(input.outcome.reason === undefined ? {} : { reason: input.outcome.reason }),
      actionResults: [...input.outcome.actionResults],
      depth: input.outcome.depth,
      durationMs: input.outcome.durationMs,
    });
  });
}
