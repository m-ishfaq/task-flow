import {
  closeDatabase,
  initializeAutomationDatabase,
  initializeBillingSweepDatabase,
  initializeDatabase,
  initializeWebhookDatabase,
} from '@taskflow/db';
import { createLogger } from '@taskflow/observability';
import { masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import { loadEnv } from './config/env.js';
import { createHealthServer } from './health.js';
import { createActionExecutor } from './automation/executor.js';
import { startAutomationEngine } from './automation/relay.js';
import { startWebhookDeliveryLoop } from './webhooks/delivery.js';
import { startBillingSweep } from './billing/sweep.js';

/**
 * Process entry point for the background worker (ai/phase-10-automation.md,
 * Wave 1 — `apps/worker`, which PLAN.md §6 has listed as "arriving" since
 * Phase 0).
 *
 * ## What runs here, and what deliberately does not
 *
 * This process takes only NEW background work: the automation engine, webhook
 * delivery, (Phase 11) the analytics rollup refresh, and (Phase 12 Wave 3) the
 * trial/grace-expiry billing sweep. The seven loops
 * already running on `setInterval` inside `apps/api` — the audit relay, the
 * search indexer, backlinks, chat retention, recording ingest, digests, due
 * reminders — STAY THERE. Moving them is a separate follow-up done one at a
 * time, each with its own verification; bundling seven working things into the
 * commit that introduces a new deployable is how a new deployable gets blamed
 * for someone else's regression.
 *
 * Running a second consumer process is the case the queue was built for, not a
 * new one: `claimPending`'s `SELECT ... FOR UPDATE SKIP LOCKED` means two
 * processes claim disjoint batches, and `outbox_dispatch` is per-consumer, so
 * this process's progress is independent of the API's.
 *
 * ## Everything that can fail from a config mistake fails HERE
 *
 * The env schema and the database pool, before any job ticks. A worker that
 * starts and then silently processes nothing is far harder to diagnose than one
 * that refuses to start and says which variable is wrong.
 */

const env = loadEnv();

/* The ordinary application role. Every automation action runs through it,
   under RLS, inside `withOrgScope` — the same role a human's action uses. The
   claim role (`DATABASE_AUTOMATION_URL`) is opened by the engine itself when
   it lands, the way the search indexer opens its own. */
initializeDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
  applicationName: 'taskflow-worker-app',
});

/* The CLAIM pool, as `taskflow_automation` — a role that may read the outbox
   and mark its own dispatch rows, and holds nothing on the automation tables or
   any tenant table. Optional: an instance without it serves health and runs
   nothing, and `startAutomationEngine` says so out loud rather than falling
   back to the application role, which could not claim across orgs anyway and
   would silently run nothing while looking healthy. */
if (env.DATABASE_AUTOMATION_URL !== undefined) {
  initializeAutomationDatabase({
    url: env.DATABASE_AUTOMATION_URL,
    applicationName: 'taskflow-worker-automation',
  });
}

/* The webhook delivery loop's claim pool, as `taskflow_webhook` (Wave 2,
   migration 0049). Optional like the automation pool: without it the loop
   logs a warning and stays off. */
if (env.DATABASE_WEBHOOK_URL !== undefined) {
  initializeWebhookDatabase({
    url: env.DATABASE_WEBHOOK_URL,
    applicationName: 'taskflow-worker-webhook',
  });
}

/* The billing sweep's claim pool, as `taskflow_billing_sweep` (Phase 12
   Wave 3, migration 0056). Optional like the two pools above: without it
   the sweep logs a warning and stays off — no trial or grace period will
   ever expire, which is a valid deployment shape for an instance that has
   not enabled billing enforcement yet. */
if (env.DATABASE_BILLING_SWEEP_URL !== undefined) {
  initializeBillingSweepDatabase({
    url: env.DATABASE_BILLING_SWEEP_URL,
    applicationName: 'taskflow-worker-billing-sweep',
  });
}

const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });

const health = createHealthServer();
await new Promise<void>((resolveListen) => {
  health.listen(env.WORKER_PORT, () => {
    resolveListen();
  });
});

const engine = startAutomationEngine({
  logger,
  executor: createActionExecutor(),
  intervalMs: env.WORKER_POLL_INTERVAL_MS,
});

/* The delivery loop shares the worker's master key — the same variables the
   API validates, used here to unwrap per-webhook data keys at delivery. */
const delivery = startWebhookDeliveryLoop({
  logger,
  keys: new SoftwareKeyProvider({
    masterKeys: masterKeysFromBase64({ [env.MASTER_KEY_ID]: env.MASTER_KEY_BASE64 }),
    currentMasterKeyId: env.MASTER_KEY_ID,
  }),
  intervalMs: env.WORKER_POLL_INTERVAL_MS,
});

const billingSweep = startBillingSweep({
  logger,
  pastDueGraceDays: env.BILLING_PAST_DUE_GRACE_DAYS,
  intervalMs: env.WORKER_BILLING_SWEEP_INTERVAL_MS,
});

logger.info({ port: env.WORKER_PORT }, 'worker started');

/**
 * Stop the engine, stop accepting probes, then close the pools.
 *
 * The engine's timer is cleared FIRST so no new tick starts, then the health
 * server so an orchestrator sees the process leaving rotation, and only then
 * the pools — the same drain-rather-than-drop ordering `apps/realtime`'s
 * shutdown documents. A tick already in flight finishes against a live
 * connection rather than failing partway, which would leave its batch unmarked
 * and every event in it redelivered.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      engine.stop();
      delivery.stop();
      billingSweep.stop();
      await new Promise<void>((resolveClose) => {
        health.close(() => {
          resolveClose();
        });
      });
      await closeDatabase();
      logger.info('worker stopped');
      process.exit(0);
    })();
  });
}
