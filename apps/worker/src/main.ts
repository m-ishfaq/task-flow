import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { createLogger } from '@taskflow/observability';
import { loadEnv } from './config/env.js';
import { createHealthServer } from './health.js';

/**
 * Process entry point for the background worker (ai/phase-10-automation.md,
 * Wave 1 — `apps/worker`, which PLAN.md §6 has listed as "arriving" since
 * Phase 0).
 *
 * ## What runs here, and what deliberately does not
 *
 * This process takes only NEW background work: the automation engine, webhook
 * delivery, and (Phase 11) the analytics rollup refresh. The seven loops
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

const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });

const health = createHealthServer();
await new Promise<void>((resolveListen) => {
  health.listen(env.WORKER_PORT, () => {
    resolveListen();
  });
});

logger.info({ port: env.WORKER_PORT }, 'worker started');

/* No jobs are registered yet — the engine lands in the next slice of Wave 1.
   The process is deliberately shipped before the thing it runs, the same
   build order Phase 7 Wave 1 and Phase 13 used for their gates: a deployable
   with a health check and validated config is reviewable on its own, and a
   job added to a proven container is a smaller change than both at once. */

/**
 * Stop accepting probes, then close the pool.
 *
 * The health server goes first so an orchestrator sees the process leaving
 * rotation before its database connections disappear underneath any in-flight
 * work — the same drain-rather-than-drop ordering `apps/realtime`'s shutdown
 * documents.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
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
