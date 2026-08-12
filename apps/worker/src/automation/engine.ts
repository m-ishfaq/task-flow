import { eq, schema, withOrgScope } from '@taskflow/db';
import { evaluate, resourceForTrigger, type Resource } from '@taskflow/filter';
import type { OrgId } from '@taskflow/contracts';
import { checkLoopProtection } from './loop-protection.js';
import {
  consumeExecutionBudget,
  isUnusable,
  loadRulesFor,
  orgIsActive,
  recordRun,
} from './repository.js';
import type { ActionExecutor, AutomationRule, RunOutcome, TriggerEvent } from './types.js';

/**
 * The rules engine (ai/phase-10-automation.md §1–§4).
 *
 * One event in, zero or more recorded runs out. The order of the checks below
 * IS the design, and each one is in its place for a stated reason:
 *
 *   1. Org active?        — the kill switch, once per event rather than per rule
 *   2. Rules for it?      — nothing to do is the overwhelmingly common case
 *   3. Loop protection    — pure, cheap, and refuses before anything is spent
 *   4. Condition          — the user's own question
 *   5. Budget             — LAST of the refusals, because it MUTATES
 *   6. Actions            — through the injected executor
 *
 * ## Why the budget is consumed last
 *
 * It is the only check that has a side effect. Counting an execution that was
 * going to be refused anyway lets a broken rule burn a legitimate org's hourly
 * allowance with runs that never do anything — a denial of service inflicted
 * through the control meant to prevent one. This is the identical argument
 * `checkOutboundAllowed` makes for running the telephony velocity limiter last,
 * and it is the same mistake in a different subsystem.
 *
 * ## Every path records a run
 *
 * Including the ones that do nothing. §3: "my rule did not fire" is the
 * question this history exists to answer, and a log of successes cannot tell
 * "the engine never saw the event" apart from "it saw it and said no".
 */

export interface EngineDeps {
  readonly executor: ActionExecutor;
  /** Injectable for deterministic tests; defaults to the real clock. */
  readonly now?: () => number;
}

export interface EngineResult {
  /** How many rules were considered for this event. */
  readonly considered: number;
  /** How many actually executed their actions. */
  readonly executed: number;
}

/**
 * Processes one claimed event against every rule listening for it.
 *
 * Never throws for a per-rule problem: one malformed rule must not stop the
 * rules behind it, and must not stall the queue for every event behind THEM.
 * A rule that fails is a recorded `failed` run.
 */
export async function processEvent(event: TriggerEvent, deps: EngineDeps): Promise<EngineResult> {
  const clock = deps.now ?? (() => Date.now());

  /* The org freeze, checked ONCE for the event rather than once per rule. A
     suspended org's rules must not run at all, and asking per rule would be
     the same answer N times plus N chances to forget. */
  if (!(await orgIsActive(event.orgId))) {
    return { considered: 0, executed: 0 };
  }

  const rules = await loadRulesFor(event.orgId, event.name);
  if (rules.length === 0) return { considered: 0, executed: 0 };

  let executed = 0;

  for (const rule of rules) {
    const startedAt = clock();

    if (isUnusable(rule)) {
      /* Reported against that rule alone, so the author can see it and the
         other rules on the same event still run. */
      await safeRecord(event, {
        automationId: rule.id,
        status: 'refused',
        reason: 'condition_unusable',
        actionResults: [],
        depth: event.causationDepth,
        durationMs: clock() - startedAt,
      });
      continue;
    }

    const outcome = await runOne(rule, event, deps, clock, startedAt);
    if (outcome.status === 'succeeded' || outcome.status === 'failed') executed += 1;
    await safeRecord(event, outcome);
  }

  return { considered: rules.length, executed };
}

async function runOne(
  rule: AutomationRule,
  event: TriggerEvent,
  deps: EngineDeps,
  clock: () => number,
  startedAt: number,
): Promise<RunOutcome> {
  const base = {
    automationId: rule.id,
    actionResults: [] as const,
    depth: event.causationDepth,
  };
  const done = (status: RunOutcome['status'], reason?: RunOutcome['reason']): RunOutcome => ({
    ...base,
    status,
    ...(reason === undefined ? {} : { reason }),
    durationMs: clock() - startedAt,
  });

  /* 3. Loop protection — pure, so it costs nothing and refuses before the
        budget is touched. */
  const loop = checkLoopProtection(rule, event.causationDepth);
  if (!loop.allowed) return done('refused', loop.reason);

  /* 4. The condition. A rule with none fires on every occurrence. */
  if (rule.condition !== null) {
    /* WHICH field set is a property of the TRIGGER, and the same function the
       API validated the rule with at save time (§7.8b). Reading it from the
       rule row instead would let the two disagree after an edit. */
    const resource = resourceForTrigger(event.name);
    const row = await evaluableRowFor(resource, event);
    if (row === null) return done('refused', 'trigger_not_evaluable');

    /* `viewerId` is deliberately NOT passed. A rule has no viewer, so `@me`
       has no meaning in one — it is refused at save time, and its absence here
       means a tree that somehow carried it evaluates to false rather than
       silently resolving to whoever saved the rule. The trap 0014's header
       documents for shared views, in a context with no user at all. */
    if (!evaluate(resource, rule.condition, row)) {
      return done('skipped', 'condition_not_met');
    }
  }

  /* 5. The budget — LAST of the refusals, because it is the only one that
        mutates. See the file header. */
  if (!(await consumeExecutionBudget(rule.orgId))) {
    return done('refused', 'budget_exhausted');
  }

  /* 6. Actions, through the injected executor. Any throw becomes a recorded
        failure rather than a stalled queue. */
  try {
    const results = await deps.executor.execute({
      rule,
      event,
      /* The depth the actions' OWN events must carry. This is what makes the
         counter survive the hop, and therefore what makes a two-rule mutual
         cycle terminate. */
      nextDepth: event.causationDepth + 1,
    });

    const failed = results.some((result) => result.status === 'failed');
    return {
      automationId: rule.id,
      status: failed ? 'failed' : 'succeeded',
      actionResults: results,
      depth: event.causationDepth,
      durationMs: clock() - startedAt,
    };
  } catch (error) {
    return {
      automationId: rule.id,
      status: 'failed',
      actionResults: [
        {
          index: 0,
          type: rule.actions[0]?.type ?? 'unknown',
          status: 'failed',
          error: error instanceof Error ? error.message : 'unknown error',
        },
      ],
      depth: event.causationDepth,
      durationMs: clock() - startedAt,
    };
  }
}

/**
 * Builds the row a condition is evaluated against.
 *
 * Wave 1 evaluates conditions against the CARD, re-read from `work.cards` — the
 * same "the source row is authoritative, the event is only the wake-up"
 * discipline the search indexer follows. An event payload carries what its
 * consumers were promised, not every field a filter might name.
 *
 * A trigger with no card to read returns null, and the engine records
 * `trigger_not_evaluable` rather than evaluating against an empty row — which
 * would silently answer "no" for every condition and look exactly like a
 * condition that legitimately did not match.
 *
 * Keyed by FIELD name, not column name: that is what `packages/filter`'s
 * evaluator expects, and what `filter.parity.test.ts` asserts both backends
 * agree on.
 *
 * ## The connector case reads the PAYLOAD, and that is not an exception
 *
 * A connector event (§7.8b) has no card and never will — it is not one. Its two
 * filterable fields are the wrapper the inbound route built and validated, so
 * the payload IS the authoritative source here, not a shortcut around re-reading
 * a row. The "source row is authoritative" discipline above is about not
 * trusting an event's copy of something a table also holds; there is no table.
 *
 * `trigger_not_evaluable` is unchanged for every other card-less trigger. This
 * narrows when it fires; it does not remove it — and a connector event missing
 * its own wrapper fields still returns null rather than an empty row, because a
 * condition silently answering "no" is the failure this function exists to
 * avoid.
 */
async function evaluableRowFor(
  resource: Resource,
  event: TriggerEvent,
): Promise<Record<string, unknown> | null> {
  if (resource === 'connector') {
    const providerEvent = event.payload['providerEvent'];
    const providerScope = event.payload['providerScope'];
    if (typeof providerEvent !== 'string' || typeof providerScope !== 'string') return null;

    /* Snake_case keys, because the evaluator looks a value up by FIELD name and
       the connector fields are `provider_event` / `provider_scope`. The payload
       is camelCase (the registry's convention), so this is a rename and not a
       pass-through — writing `{ ...event.payload }` would produce a row where
       every condition matched nothing. */
    return { provider_event: providerEvent, provider_scope: providerScope };
  }

  const cardId = typeof event.payload['cardId'] === 'string' ? event.payload['cardId'] : null;
  if (cardId === null) return null;

  return withOrgScope(event.orgId, async (tx) => {
    const rows = await tx
      .select({
        title: schema.cards.title,
        description: schema.cards.descriptionText,
        list: schema.cards.listId,
        status: schema.cards.statusId,
        priority: schema.cards.priority,
        board: schema.cards.boardId,
        project: schema.cards.projectId,
        number: schema.cards.number,
        assignee: schema.cards.assigneeIds,
        creator: schema.cards.createdBy,
        due: schema.cards.dueDate,
        start: schema.cards.startDate,
        created: schema.cards.createdAt,
        updated: schema.cards.updatedAt,
        comments: schema.cards.commentCount,
        checklistDone: schema.cards.checklistDone,
        checklistTotal: schema.cards.checklistTotal,
        archivedAt: schema.cards.archivedAt,
      })
      .from(schema.cards)
      .where(eq(schema.cards.id, cardId))
      .limit(1);

    const card = rows[0];
    if (!card) return null;

    const { archivedAt, ...fields } = card;
    /* `archived` is a boolean field in the card field set, and the column is a
       nullable timestamp — the same normalization the search projection does. */
    return { ...fields, archived: archivedAt !== null };
  });
}

/**
 * Records a run, swallowing a failure to record.
 *
 * A run that happened and could not be written down is bad; a run that happened
 * and then threw out of the drain loop — leaving the whole batch unmarked and
 * every event in it to be redelivered — is worse. History is telemetry
 * (§3), and it is not worth the queue.
 */
async function safeRecord(event: TriggerEvent, outcome: RunOutcome): Promise<void> {
  try {
    await recordRun(event.orgId, {
      eventId: event.id,
      triggerEvent: event.name,
      outcome,
    });
  } catch {
    // Deliberately swallowed — see above.
  }
}

/** Re-exported so the relay and tests share one definition of the org type. */
export type { OrgId };
