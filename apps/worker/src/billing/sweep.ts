import {
  and,
  eq,
  hasBillingSweepDatabase,
  lt,
  recordOperationalEvent,
  schema,
  withBillingSweepScope,
} from '@taskflow/db';
import type { OrgId } from '@taskflow/contracts';
import type { Logger } from '@taskflow/observability';
import { expireGracePeriod, expireTrial } from '@taskflow/api/billing/sweep';

/**
 * The trial/grace-expiry sweep (Phase 12 Wave 3 §3.4, ai/phase-12-wave3.md).
 *
 * Two steps, per tick, mirroring every other consumer loop in this codebase:
 *
 *  1. SCAN, cross-tenant, as `taskflow_billing_sweep` (read-only) — every
 *     trialing org whose trial has ended, every past_due org whose grace
 *     has ended.
 *  2. WRITE, per matched org, as `taskflow_app` under `withOrgScope` —
 *     `expireTrial`/`expireGracePeriod` (`@taskflow/api/billing/sweep`),
 *     the same conditional-UPDATE service functions a webhook-triggered
 *     transition would use, so a row already moved on by something else
 *     between the scan and this write simply matches zero rows.
 *
 * No SKIP-LOCKED claim of its own, unlike the outbox consumers — there is
 * only ever one billing sweep tick's worth of work to do, and the
 * conditional UPDATE in step 2 is what makes running this loop on two
 * worker instances at once merely redundant rather than incorrect.
 */
export function startBillingSweep(options: {
  readonly logger: Logger;
  readonly pastDueGraceDays: number;
  readonly intervalMs: number;
}): { readonly stop: () => void } {
  if (!hasBillingSweepDatabase()) {
    options.logger.warn(
      'billing sweep not started: DATABASE_BILLING_SWEEP_URL is unset, so no trial or grace period will ever expire',
    );
    return { stop: () => undefined };
  }

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const [expiredTrials, expiredGraces] = await Promise.all([
        scanExpiredTrials(),
        scanExpiredGracePeriods(),
      ]);

      let trialsExpired = 0;
      for (const orgId of expiredTrials) {
        if (await expireTrial(orgId, { pastDueGraceDays: options.pastDueGraceDays })) {
          trialsExpired += 1;
        }
      }

      let gracesExpired = 0;
      for (const orgId of expiredGraces) {
        if (await expireGracePeriod(orgId)) {
          gracesExpired += 1;
        }
      }

      if (trialsExpired > 0 || gracesExpired > 0) {
        options.logger.info({ trialsExpired, gracesExpired }, 'billing sweep applied transitions');
      }

      /* Recorded on EVERY tick, not only when something transitioned — this
         is a HEARTBEAT, and a dashboard that only ever sees a row when there
         was work to do cannot tell "the sweep is healthy and idle" apart
         from "the sweep died three days ago". `trialsExpired`/`gracesExpired`
         being 0 is itself the answer to "is anything overdue right now". */
      void recordOperationalEvent({
        kind: 'billing_sweep',
        outcome: 'success',
        detail: { trialsExpired, gracesExpired },
      });
    } catch (error) {
      // Logged, never rethrown — the identical reasoning every other loop's
      // tick in this codebase gives: a transient blip must not take the
      // process down, and every deadline is still there for the next tick.
      options.logger.error({ err: error }, 'billing sweep tick failed');
      // No error message in `detail` — the same redaction discipline every
      // other recordOperationalEvent() call site applies.
      void recordOperationalEvent({ kind: 'billing_sweep', outcome: 'failure' });
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

async function scanExpiredTrials(): Promise<readonly OrgId[]> {
  return withBillingSweepScope(async (tx) => {
    const rows = await tx
      .select({ id: schema.orgs.id })
      .from(schema.orgs)
      .where(
        and(eq(schema.orgs.billingStatus, 'trialing'), lt(schema.orgs.trialEndsAt, new Date())),
      );
    return rows.map((row) => row.id as OrgId);
  });
}

async function scanExpiredGracePeriods(): Promise<readonly OrgId[]> {
  return withBillingSweepScope(async (tx) => {
    const rows = await tx
      .select({ id: schema.orgs.id })
      .from(schema.orgs)
      .where(
        and(
          eq(schema.orgs.billingStatus, 'past_due'),
          lt(schema.orgs.billingGraceEndsAt, new Date()),
        ),
      );
    return rows.map((row) => row.id as OrgId);
  });
}
