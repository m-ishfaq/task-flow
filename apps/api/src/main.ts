import {
  closeDatabase,
  initializeAuditDatabase,
  initializeBacklinksDatabase,
  initializeDatabase,
} from '@taskflow/db';
import { createLogger } from '@taskflow/observability';
import { loadEnv } from './config/env.js';
import { buildServer } from './server.js';
import { startAuditRelay } from './tenancy/relay.js';
import { startRetentionSweep } from './chat/retention.scheduler.js';
import { startBacklinksRelay } from './docs/backlinks.relay.js';
import { createNotificationMailDelivery } from './platform/notification-mail.js';

/**
 * Process entry point.
 *
 * Everything that can fail because of a configuration mistake fails HERE, before
 * the first connection is accepted: the env schema, the database pool, and the
 * route manifest assertion inside `buildServer`. A server that starts and then
 * rejects every request is far harder to diagnose than one that refuses to start
 * and says why.
 */

const env = loadEnv();

initializeDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
  applicationName: 'taskflow-api',
});

/**
 * The audit writer, on its own role and its own pool (§8.6).
 *
 * Separate from the application connection because `taskflow_audit` holds
 * INSERT and SELECT on `audit.audit_log` and no UPDATE or DELETE anywhere — so
 * the compliance record cannot be rewritten by the process that writes it.
 * Optional: an instance without it serves requests and lets another drain the
 * queue.
 */
if (env.DATABASE_AUDIT_URL !== undefined) {
  initializeAuditDatabase({ url: env.DATABASE_AUDIT_URL, applicationName: 'taskflow-audit' });
}

/**
 * The backlinks relay's claim connection, on its own role and pool (Phase 6
 * Wave 3, §3.10). Same optionality reasoning as the audit pool above:
 * `taskflow_backlinks` reads across every tenant's `docs.page_versions`
 * metadata (never `state`) and nothing else, so an instance without this
 * variable serves requests and lets another drain the backlog.
 */
if (env.DATABASE_BACKLINKS_URL !== undefined) {
  initializeBacklinksDatabase({
    url: env.DATABASE_BACKLINKS_URL,
    applicationName: 'taskflow-backlinks',
  });
}

const app = await buildServer({ env });

/* The notification email queue (Phase 9, ai/phase-9-notifications.md §3.6) —
   its own MailQueue instance, own connection to MAIL_HOST, separate from
   identity's so a notification backlog never contends with a password-reset
   email. Constructed unconditionally: it costs nothing idle, and the relay
   below only ever calls `send` when there is something to send. */
const notificationMail = createNotificationMailDelivery({ env });

/* Moves domain events from the outbox into the hash-chained audit log. Belongs
   in apps/worker on a pg-boss schedule once that exists (Phase 4) — see the
   note in tenancy/relay.ts. */
const relay = startAuditRelay({
  logger: createLogger({ name: 'audit-relay', level: env.LOG_LEVEL }),
  sendNotificationEmail: notificationMail.send,
});

/* Folds new docs.page_versions rows into docs.backlinks and emits
   page.content_updated (Phase 6 Wave 3, §3.10). Same "belongs in
   apps/worker" caveat as the audit relay above. */
const backlinksRelay = startBacklinksRelay({
  logger: createLogger({ name: 'backlinks-relay', level: env.LOG_LEVEL }),
});

/* Deletes chat messages past their channel's retention window (Wave 4, §3.7).
   Same "belongs in apps/worker" caveat as the relay above, plus one the relay
   does NOT have: this sweep has no `SKIP LOCKED` claim, so running it in two
   instances at once double-counts deletions in the audit log. Off by default
   for that reason — exactly one instance should set it. */
const retention = env.RETENTION_SWEEP_ENABLED
  ? startRetentionSweep({
      logger: createLogger({ name: 'chat-retention', level: env.LOG_LEVEL }),
    })
  : null;

await app.listen({ port: env.API_PORT, host: env.API_HOST });

/**
 * Drain rather than drop.
 *
 * Without this, a deploy kills in-flight requests — including ones that have
 * already written to the database but not yet emitted their domain event, which
 * is precisely the state the transactional outbox exists to make impossible.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      // Relays first: stopping them before the pools close means an
      // in-flight drain finishes against a live connection rather than
      // failing partway.
      relay.stop();
      backlinksRelay.stop();
      retention?.stop();
      await app.close();
      await closeDatabase();
      process.exit(0);
    })();
  });
}
