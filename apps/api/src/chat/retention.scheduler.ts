import { listOrgIds } from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { asOrgId, sweepAllOrgs } from './retention.js';

/**
 * Drives the chat retention sweep on a timer
 * (ai/phase-5-chat.md §3.7; PLAN.md §4.2).
 *
 * ## This is a placeholder, and saying so is the point
 *
 * It belongs in `apps/worker` on a pg-boss schedule, exactly like
 * `tenancy/relay.ts` says of the outbox relay — and that app still does not
 * exist. It runs here for the same reason the relay does: a retention policy
 * that nothing enforces is not a policy, it is a column. A timer in the API is
 * the smallest thing that makes it real today.
 *
 * When `apps/worker` arrives, `sweepAllOrgs` moves unchanged; it takes no
 * ambient state, so relocating it is a change of caller rather than of code.
 *
 * ## Unlike the relay, this is NOT safe to run in every instance
 *
 * The outbox relay claims rows with `FOR UPDATE SKIP LOCKED`, so instances take
 * disjoint batches. This sweep has no such claim: two instances ticking at once
 * would both compute the same cutoff and both issue the same DELETE. The second
 * one deletes nothing (the rows are gone) but still emits a batch of
 * `message.deleted` events for messages it did not delete, which puts
 * duplicate deletions in the compliance record.
 *
 * `RETENTION_SWEEP_ENABLED` is what stops that: one instance runs it. That is a
 * deployment constraint rather than a guarantee, and it is the honest state of
 * things until pg-boss provides a real schedule with a real lock. Stated here
 * rather than discovered, because the symptom — an audit log double-counting
 * deletions — appears long after the second instance starts.
 *
 * ## Why the interval is an hour and not a minute
 *
 * Retention windows are measured in days. A message becoming eligible at 14:03
 * and being deleted at 15:00 is indistinguishable from correct to everyone
 * involved, and an hourly tick means a scan of every channel's policy happens
 * 24 times a day instead of 1,440.
 */

/** One hour. See the note above on why not shorter. */
const TICK_MS = 60 * 60 * 1000;

export interface RetentionHandle {
  stop: () => void;
}

export interface StartRetentionOptions {
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export function startRetentionSweep(options: StartRetentionOptions): RetentionHandle {
  const interval = options.intervalMs ?? TICK_MS;
  let running = false;

  const tick = (): void => {
    /* Skipped rather than queued when a previous tick is still going. A sweep
       that takes longer than its interval would otherwise stack, and two
       overlapping passes are exactly the double-delete case described above —
       from one process rather than two. */
    if (running) return;
    running = true;

    void (async () => {
      try {
        /* The one unscoped read in this job, and it lives in `packages/db`
           rather than here — see `tenants.ts`. It returns ids only, so the
           sweep must re-enter `withOrgScope` per org to touch anything. */
        const orgIds = await listOrgIds();
        const result = await sweepAllOrgs(orgIds.map(asOrgId));

        if (result.messagesDeleted > 0) {
          options.logger.info(
            { orgsSwept: result.orgsSwept, messagesDeleted: result.messagesDeleted },
            'chat retention sweep removed messages',
          );
        }
      } catch (error) {
        /* Logged and swallowed. A sweep that throws must not take the API
           process with it — the consequence of a missed tick is that messages
           live an hour longer, and the consequence of an unhandled rejection is
           that nothing serves requests. */
        options.logger.error({ err: error }, 'chat retention sweep failed');
      } finally {
        running = false;
      }
    })();
  };

  const timer = setInterval(tick, interval);
  /* Unref'd so the timer never keeps the process alive on its own — the same
     reason `relay.ts` and the gateway's rate-limit sweeper do it. */
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
