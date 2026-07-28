import { hasAuditDatabase } from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { drainOutboxFully } from './audit.projection.js';

/**
 * Drives the outbox relay on a timer (PLAN.md §10.6).
 *
 * ## This is a placeholder, and saying so is the point
 *
 * The relay belongs in `apps/worker` on a pg-boss schedule (§4.2), and that app
 * does not exist until Phase 4. It runs here because the outbox carries real
 * traffic from Phase 2 onward, and an audit log that nothing writes to is not a
 * control — it is a table. A timer in the API is the smallest thing that makes
 * the audit trail real today.
 *
 * Two properties make it safe to run in every API instance rather than
 * requiring a leader:
 *
 *   - `claimPending` uses `FOR UPDATE SKIP LOCKED`, so instances claim disjoint
 *     batches instead of contending or double-processing.
 *   - The claim, the audit writes, and the mark-published are one transaction,
 *     so an instance that dies mid-batch releases its rows and the next run
 *     redoes them with no duplicates.
 *
 * What it is NOT is timely. A tick interval means audit entries lag their
 * mutations by up to that interval, which is fine for a compliance record and
 * would not be fine for, say, a notification. Consumers with latency
 * requirements get pg-boss dispatch in Phase 4 rather than a shorter timer.
 */

/**
 * Five seconds.
 *
 * Short enough that the audit log is effectively live when someone is watching
 * it, long enough that an idle system is not issuing a pointless query every
 * second for the entire life of the process. The backlog is bounded by
 * `drainOutboxFully`, so a burst does not have to wait for several ticks.
 */
const TICK_MS = 5_000;

export interface RelayHandle {
  stop: () => void;
}

export interface StartRelayOptions {
  readonly logger: Logger;
  readonly intervalMs?: number;
}

/**
 * Starts the relay, or does nothing if no audit connection was configured.
 *
 * Returning a no-op handle rather than throwing is deliberate: an API instance
 * with no `DATABASE_AUDIT_URL` is a valid deployment — it serves requests and
 * lets another process drain the queue. What must never happen silently is
 * audit entries being written by the application role, and that is prevented at
 * the other end, by grants, rather than by this check.
 */
export function startAuditRelay(options: StartRelayOptions): RelayHandle {
  if (!hasAuditDatabase()) {
    options.logger.warn(
      'audit relay not started: DATABASE_AUDIT_URL is unset, so domain events will accumulate in the outbox unprocessed',
    );
    return { stop: () => undefined };
  }

  let running = false;

  const tick = async (): Promise<void> => {
    // Skip rather than queue. A drain that outlasts the interval would
    // otherwise start overlapping with itself, and while SKIP LOCKED keeps that
    // correct, it turns a slow database into an unbounded number of concurrent
    // transactions against it.
    if (running) return;
    running = true;

    try {
      const result = await drainOutboxFully();
      if (result.processed > 0) {
        options.logger.debug({ processed: result.processed }, 'audit relay drained outbox');
      }
    } catch (error) {
      /* Logged, never rethrown. An unhandled rejection inside a timer takes the
         process down, and a transient database blip must not turn into an API
         outage — the events are still in the outbox and the next tick retries
         them, which is exactly what the table is for. */
      options.logger.error({ err: error }, 'audit relay tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? TICK_MS);

  // Does not hold the event loop open: a process whose only remaining work is
  // this timer should be allowed to exit.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
