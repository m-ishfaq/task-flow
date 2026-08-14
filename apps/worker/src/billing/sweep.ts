import {
  and,
  eq,
  hasBillingSweepDatabase,
  isNotNull,
  lt,
  recordOperationalEvent,
  schema,
  withBillingSweepScope,
} from '@taskflow/db';
import type { OrgId } from '@taskflow/contracts';
import type { Logger } from '@taskflow/observability';
import {
  applyPendingPlanChange,
  expireGracePeriod,
  expireTrial,
} from '@taskflow/api/billing/sweep';
import {
  sendBillingMail,
  warnTrialEnding,
  type BillingMailDeps,
} from '@taskflow/api/billing/billing-mail';
import { closeUsagePeriod } from '@taskflow/api/billing/overage';
import type { PaymentProvider } from '@taskflow/contracts';

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
  /* Where an expiring trial lands is NOT configured here: it is
     `billing.plans.is_default`, read per org by the sweep. One source of
     truth, already enforced by a unique index. */
  readonly trialEndingWarningHours: number;
  /**
   * Where the trial-ending warning goes. Optional: a worker with no mailer
   * configured still runs every transition and simply sends nothing, rather
   * than failing the sweep over an email.
   */
  readonly mail?: BillingMailDeps | undefined;
  /**
   * The processor the period-close job bills overage through (§3.8).
   *
   * Optional, and its absence SKIPS the close entirely rather than closing
   * periods without charging for them. That direction matters: a closed
   * period is a claimed row, and a row claimed with nothing billed can never
   * be retried — a worker started without a payments provider would silently
   * write off every tenant's overage, permanently, and look healthy doing it.
   */
  readonly payments?: PaymentProvider | undefined;
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

      let planChangesApplied = 0;
      let trialWarningsSent = 0;
      let trialsExpired = 0;
      for (const orgId of expiredTrials) {
        /* Parked downgrades first, and independently of the status
           transitions below: a downgrade that has come due is true whatever
           the org's billing status is, and an org can legitimately be
           past_due with a pending plan change waiting. */
        if ((await applyPendingPlanChange(orgId)) !== null) {
          planChangesApplied += 1;
        }

        /* Warn BEFORE expiring, and in the same pass: an org whose trial
           ends within the window gets the warning on this tick, and the org
           whose trial has already run out gets the switch on this one. The
           two are mutually exclusive by construction — `warnTrialEnding`
           returns false once the deadline is in the past. */
        if (
          await warnTrialEnding(orgId, {
            warningHours: options.trialEndingWarningHours,
            mail: options.mail,
          })
        ) {
          trialWarningsSent += 1;
        }

        if (await expireTrial(orgId)) {
          trialsExpired += 1;

          /* The follow-up to `warnTrialEnding` above — sent once the switch
             has actually happened, on the same tick that made it true.
             Best-effort, exactly like every other billing send here: a
             worker with no mailer configured still applies the transition
             and simply tells nobody, rather than failing the sweep. */
          if (options.mail !== undefined) {
            void sendBillingMail(options.mail, orgId, 'trial_ended');
          }
        }
      }

      /* Usage periods, after the status transitions rather than before: a
         pending downgrade applied above changes which plan's allowance the
         NEXT period is measured against, and nothing about the period that
         already closed. Ordering them the other way would work too — this
         way round simply keeps "what plan are they on" settled first. */
      let periodsClosed = 0;
      let overageCharged = 0;
      if (options.payments !== undefined) {
        for (const orgId of await scanSubscribedOrgs()) {
          const outcome = await closeUsagePeriod(orgId, { payments: options.payments });
          if (!outcome.closed) continue;
          periodsClosed += 1;
          if ((outcome.billableCents ?? 0) > 0) overageCharged += 1;
        }
      }

      let gracesExpired = 0;
      for (const orgId of expiredGraces) {
        if (await expireGracePeriod(orgId)) {
          gracesExpired += 1;
        }
      }

      if (
        trialsExpired > 0 ||
        gracesExpired > 0 ||
        planChangesApplied > 0 ||
        trialWarningsSent > 0 ||
        periodsClosed > 0
      ) {
        options.logger.info(
          {
            trialsExpired,
            gracesExpired,
            planChangesApplied,
            trialWarningsSent,
            periodsClosed,
            overageCharged,
          },
          'billing sweep applied transitions',
        );
      }

      /* Recorded on EVERY tick, not only when something transitioned — this
         is a HEARTBEAT, and a dashboard that only ever sees a row when there
         was work to do cannot tell "the sweep is healthy and idle" apart
         from "the sweep died three days ago". `trialsExpired`/`gracesExpired`
         being 0 is itself the answer to "is anything overdue right now". */
      void recordOperationalEvent({
        kind: 'billing_sweep',
        outcome: 'success',
        detail: { trialsExpired, gracesExpired, periodsClosed },
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

/**
 * Every org with a subscription to bill against.
 *
 * Deliberately NOT filtered on "the period has ended" — that question is
 * `closeUsagePeriod`'s, answered from the chained period in
 * `billing.usage_charges` rather than from a column this scan can see, and
 * duplicating the rule here would give it two implementations that drift. The
 * cost is one cheap read per subscribed org per tick, against a table already
 * indexed by primary key.
 *
 * Read-only, as `taskflow_billing_sweep`, like the two scans beside it: this
 * decides what to LOOK at and never what to charge.
 */
async function scanSubscribedOrgs(): Promise<readonly OrgId[]> {
  return withBillingSweepScope(async (tx) => {
    const rows = await tx
      .select({ id: schema.orgs.id })
      .from(schema.orgs)
      .where(isNotNull(schema.orgs.stripeSubscriptionId));
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
