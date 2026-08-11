import {
  claimPending,
  hasAutomationDatabase,
  markDispatched,
  withAutomationScope,
  type OutboxRow,
} from '@taskflow/db';
import { unsafeAsId } from '@taskflow/contracts';
import type { Logger } from '@taskflow/observability';
import { processEvent } from './engine.js';
import type { ActionExecutor, TriggerEvent } from './types.js';

/**
 * The automation engine's outbox consumer (ai/phase-10-automation.md §1).
 *
 * The fifth relay in this codebase and the same three steps as the other four
 * — `tenancy/relay.ts`, `apps/realtime/src/relay.ts`, `docs/backlinks.relay.ts`
 * and `search/indexer.relay.ts`:
 *
 *  1. CLAIM, cross-tenant, as `taskflow_automation` — `claimPending(tx,
 *     'automation')` over the per-consumer `outbox_dispatch` bookkeeping
 *     migration 0015 established.
 *  2. WORK, per event, under `withOrgScope` as `taskflow_app` — loading rules,
 *     evaluating conditions, executing actions through the service layer.
 *  3. MARK, in the same claim transaction — `markDispatched`.
 *
 * ## At-least-once, and what that means for a rule
 *
 * The claim contract is at-least-once, so a redelivered event runs its rules
 * again. Unlike the search indexer — where redelivery is harmless because every
 * write is an upsert on a unique key — an automation ACTS, and acting twice is
 * visible: two chat messages, two labels.
 *
 * Wave 1 accepts that rather than papering over it, and says so here because it
 * is a real property and not an oversight. Redelivery requires the process to
 * die between executing actions and marking the batch, which is a narrow
 * window; the alternatives all cost more than they save. Marking BEFORE acting
 * would turn every crash into silently skipped automations, which is strictly
 * worse — a rule that did not fire is much harder to notice than one that fired
 * twice. A dedupe key on `automation_runs` is the honest fix and it belongs
 * with the idempotency work Wave 2's webhook delivery needs anyway.
 */

/** The consumer name this relay claims under (migration 0047). */
export const AUTOMATION_CONSUMER = 'automation';

export interface AutomationDrainResult {
  readonly processed: number;
  /** Events that matched at least one rule and executed it. */
  readonly executed: number;
}

/** Narrows a claimed outbox row into what the engine reads. */
function toTriggerEvent(row: OutboxRow): TriggerEvent | null {
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return null;

  return {
    id: row.id,
    orgId: unsafeAsId<'OrgId'>(row.orgId),
    name: row.name,
    payload: payload as Record<string, unknown>,
    /* Already narrowed by `claimPending`, which defaults anything unusable —
       including a NEGATIVE value, which would make the cap unreachable — to 0.
       A row predating migration 0048 and a human-initiated mutation are both
       legitimately depth 0: the root of any chain they start. */
    causationDepth: row.causationDepth,
  };
}

/** One claim-and-process batch. */
export async function drainAutomations(
  deps: { readonly executor: ActionExecutor },
  limit = 50,
): Promise<AutomationDrainResult> {
  return withAutomationScope(async (tx) => {
    const claimed = await claimPending(tx, AUTOMATION_CONSUMER, limit);
    if (claimed.length === 0) return { processed: 0, executed: 0 };

    let executed = 0;
    for (const row of claimed) {
      const event = toTriggerEvent(row);
      if (event === null) continue;

      const result = await processEvent(event, { executor: deps.executor });
      executed += result.executed;
    }

    await markDispatched(
      tx,
      AUTOMATION_CONSUMER,
      claimed.map((row) => row.id),
    );

    return { processed: claimed.length, executed };
  });
}

/**
 * Drains until the backlog is empty, bounded by `maxBatches`.
 *
 * The bound matters more here than for the other relays: an automation can
 * produce events, so an unbounded loop could chase its own output for as long
 * as the depth cap allows on every branch. `maxBatches` makes a tick's work
 * finite regardless of what the rules do.
 */
export async function drainAutomationsFully(
  deps: { readonly executor: ActionExecutor },
  batchSize = 50,
  maxBatches = 20,
): Promise<AutomationDrainResult> {
  let processed = 0;
  let executed = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainAutomations(deps, batchSize);
    processed += result.processed;
    executed += result.executed;
    if (result.processed < batchSize) break;
  }

  return { processed, executed };
}

/**
 * Starts the engine, or does nothing if no automation connection was
 * configured.
 *
 * Mirrors `startSearchIndexRelay`'s shape and reasoning: a deployment with no
 * `DATABASE_AUTOMATION_URL` is valid — it serves health and runs whatever else
 * it is given — and what must never happen silently is `taskflow_automation`'s
 * narrow claim grant being bypassed by a fallback to the application role.
 */
export function startAutomationEngine(options: {
  readonly logger: Logger;
  readonly executor: ActionExecutor;
  readonly intervalMs: number;
}): { readonly stop: () => void } {
  if (!hasAutomationDatabase()) {
    options.logger.warn(
      'automation engine not started: DATABASE_AUTOMATION_URL is unset, so no rule will ever run',
    );
    return { stop: () => undefined };
  }

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const result = await drainAutomationsFully({ executor: options.executor });
      if (result.processed > 0) {
        options.logger.debug(
          { processed: result.processed, executed: result.executed },
          'automation engine drained outbox',
        );
      }
    } catch (error) {
      /* Logged, never rethrown — the reasoning `startAuditRelay` states: a
         transient blip must not take the process down, and the events are
         still there for the next tick. */
      options.logger.error({ err: error }, 'automation engine tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
