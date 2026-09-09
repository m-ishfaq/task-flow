import {
  closeDatabase,
  initializeApiTokenAuthDatabase,
  initializeAuditDatabase,
  initializeBacklinksDatabase,
  initializeDatabase,
  initializeIntegrationAuthDatabase,
  initializeOpsEventsDatabase,
  initializePlatformAdminDatabase,
  initializeRecordingIngestDatabase,
  initializeSearchDatabase,
  initializeSweepDatabase,
  recordOperationalEvent,
} from '@taskflow/db';
import { createLogger } from '@taskflow/observability';
import { loadEnv } from './config/env.js';
import { buildServer } from './server.js';
import { startAuditRelay } from './tenancy/relay.js';
import { startRetentionSweep } from './chat/retention.scheduler.js';
import { startBacklinksRelay } from './docs/backlinks.relay.js';
import { createNotificationMailDelivery } from './platform/notification-mail.js';
import { startDigestSweep } from './platform/digest.js';
import { startStandupDigestSweep } from './standup/digest-sweep.js';
import { startDueReminderSweep } from './platform/due-reminders.js';
import { ExpoPushProvider, WebPushProvider } from './platform/push-provider.js';
import { buildTelephonyDeps } from './telephony/deps.js';
import { createCarrierFetch, startRecordingIngest } from './telephony/ingest.scheduler.js';
import { startSearchIndexRelay } from './search/indexer.relay.js';

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

/**
 * The due-reminder sweep's claim connection, on its own role and pool
 * (Phase 9 Wave 2, §3.8; migration 0029). Same optionality reasoning as the
 * audit and backlinks pools above: `taskflow_notification_sweep` reads only
 * the due-date-relevant columns of `work.cards` across every tenant, so an
 * instance without this variable serves requests and lets another run the
 * sweep.
 */
if (env.DATABASE_NOTIFICATION_SWEEP_URL !== undefined) {
  initializeSweepDatabase({
    url: env.DATABASE_NOTIFICATION_SWEEP_URL,
    applicationName: 'taskflow-notification-sweep',
  });
}

/* The recording-ingest sweep's claim connection, on its own role and pool
   (Phase 7 Wave 2, §3.6; migration 0033). `taskflow_recording_ingest` holds a
   COLUMN-LEVEL grant on `comms.recordings` and nothing at all on `comms.calls`,
   so the role that fetches a recording cannot learn whose conversation it is.
   Same optionality reasoning as every consumer pool above. */
if (env.DATABASE_RECORDING_INGEST_URL !== undefined) {
  initializeRecordingIngestDatabase({
    url: env.DATABASE_RECORDING_INGEST_URL,
    applicationName: 'taskflow-recording-ingest',
  });
}

/* The platform-admin console's connection, on its own role and pool (Phase
   12 Wave 1, §3.7; migration 0035). Same optionality reasoning as every
   consumer pool above: `taskflow_platform_admin` reads the org directory
   across every tenant and writes orgs.status, and an instance that never
   serves a console request does not need it — `withPlatformAdminScope`
   throws rather than silently falling back to the application role, which
   cannot see across every org. */
if (env.DATABASE_PLATFORM_ADMIN_URL !== undefined) {
  initializePlatformAdminDatabase({
    url: env.DATABASE_PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-platform-admin',
  });
}

/* The search indexer's claim connection, on its own role and pool (Phase 8
   Wave 2, §2.2; migration 0045). Same optionality reasoning as every
   consumer pool above: `taskflow_search` reads the outbox across every
   tenant in one pass and holds NOTHING on `search.documents`, so an instance
   without this variable serves requests and lets another drain the backlog. */
if (env.DATABASE_SEARCH_URL !== undefined) {
  initializeSearchDatabase({
    url: env.DATABASE_SEARCH_URL,
    applicationName: 'taskflow-search',
  });
}

/* The API-token auth lookup connection, on its own role and pool (Phase 10
   Wave 3, §6.2; migration 0050). Unlike the claim pools above this one is on
   the REQUEST hot path — every token-authenticated call starts with a hash
   lookup that has no org yet (the token row names its org). Optional for the
   same reason every consumer pool is, and when it is absent
   `withApiTokenAuthScope` throws, the auth path answers unauthenticated, and
   every token request fails CLOSED rather than falling back to the
   application role, which cannot read across every org. */
if (env.DATABASE_API_TOKEN_URL !== undefined) {
  initializeApiTokenAuthDatabase({
    url: env.DATABASE_API_TOKEN_URL,
    applicationName: 'taskflow-api-token-auth',
  });
}

/* The inbound-connector lookup connection, on its own role and pool (Phase 10
   Wave 4, §7.2; migration 0056). Same optionality reasoning as every
   consumer pool above: `taskflow_integration_auth` resolves an inbound Slack
   team_id / GitHub repository full_name to an org across every tenant, and
   when it is absent `withIntegrationAuthScope` throws, the connector webhook
   routes answer 503, and every inbound connector event fails CLOSED rather
   than falling back to the application role, which cannot read across every
   org anyway. */
if (env.DATABASE_INTEGRATION_URL !== undefined) {
  initializeIntegrationAuthDatabase({
    url: env.DATABASE_INTEGRATION_URL,
    applicationName: 'taskflow-integration-auth',
  });
}

/* The operations dashboard's writer connection (migration 0061). Optional
   for the same reason every consumer pool is — recordOperationalEvent()
   catches the missing-connection error itself (packages/db/src/ops-events.ts's
   own comment), so an instance without this simply gets no dashboard rows
   for mail delivery / billing webhook outcomes rather than a broken mail
   queue or a failing webhook route. */
if (env.DATABASE_OPS_EVENTS_URL !== undefined) {
  initializeOpsEventsDatabase({
    url: env.DATABASE_OPS_EVENTS_URL,
    applicationName: 'taskflow-ops-events',
  });
}

const telephonyDeps = buildTelephonyDeps(env);

/* The notification email queue (Phase 9, ai/phase-9-notifications.md §3.6) —
   its own MailQueue instance, own connection to MAIL_HOST, separate from
   identity's so a notification backlog never contends with a password-reset
   email. Constructed unconditionally: it costs nothing idle, and the relay
   below only ever calls `send` when there is something to send.
   Built BEFORE `buildServer` (moved from after it) so `notificationMail.send`
   can be threaded into the router as `platform.sendNotificationEmail` —
   `platformAdmin`'s operator broadcasts need it directly, the same reason
   `tenancy/relay.ts` already takes it (see PlatformAdminRouterDeps's own
   comment on why that module bypasses the notification projection). */
const notificationMailLogger = createLogger({ name: 'notification-mail', level: env.LOG_LEVEL });
const notificationMail = createNotificationMailDelivery({
  env,
  onFailure: (failure) => {
    /* This queue never had an onFailure handler before this — a failed
       notification email abandoned silently, with nothing to grep for
       even in a live incident. Same redaction as identity's own queue:
       to/subject/reason only, never the body — reason is the transport's
       own error text, see MailFailure's own comment in @taskflow/mail. */
    notificationMailLogger.error(
      {
        to: failure.to,
        subject: failure.subject,
        attempts: failure.attempts,
        reason: failure.reason,
      },
      'mail delivery abandoned',
    );
    void recordOperationalEvent({
      kind: 'mail',
      outcome: 'failure',
      target: failure.to,
      detail: { subject: failure.subject, attempts: failure.attempts, reason: failure.reason },
    });
  },
  onSuccess: (success) => {
    void recordOperationalEvent({
      kind: 'mail',
      outcome: 'success',
      target: success.to,
      detail: { subject: success.subject },
    });
  },
});

const app = await buildServer({ env, sendNotificationEmail: notificationMail.send });

/* The Web Push provider (§3.7). VAPID keys are OPTIONAL in the env schema:
   an instance without them is a valid deployment that simply does not send
   push — the preferences UI reports that honestly rather than pretending the
   channel works. When the keys ARE present, the relay below drains the
   pending push delivery rows on every tick. */
const pushProvider =
  env.VAPID_PRIVATE_KEY !== undefined && env.VAPID_SUBJECT !== undefined
    ? new WebPushProvider({
        VAPID_SUBJECT: env.VAPID_SUBJECT,
        VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
      })
    : undefined;

/* The native mobile push provider (Phase 14 §9). Always constructed, unlike
   `pushProvider` above — see `ExpoPushProvider`'s own header on why it
   needs no server-held secret to send at all; `EXPO_ACCESS_TOKEN` only
   raises rate limits and stays optional. */
const expoPushProvider = new ExpoPushProvider(
  env.EXPO_ACCESS_TOKEN === undefined ? {} : { accessToken: env.EXPO_ACCESS_TOKEN },
);

/* Moves domain events from the outbox into the hash-chained audit log. Belongs
   in apps/worker on a pg-boss schedule once that exists (Phase 4) — see the
   note in tenancy/relay.ts. */
const relay = startAuditRelay({
  logger: createLogger({ name: 'audit-relay', level: env.LOG_LEVEL }),
  sendNotificationEmail: notificationMail.send,
  /* `exactOptionalPropertyTypes` refuses an explicit undefined here — the
     option must be absent when push is off, not present-and-undefined. */
  ...(pushProvider === undefined ? {} : { pushProvider }),
  expoPushProvider,
});

/* The daily digest sweep (§3.4) and the hourly due-reminder sweep (§3.8),
   both in the same accepted timer-in-`apps/api` placeholder every background
   job uses until apps/worker exists. Digest mail goes through the SAME
   MailQueue as the relay's one-off sends — a daily batch arriving a tick late
   is a scheduling detail, not a correctness one. */
const digestSweep = startDigestSweep({
  logger: createLogger({ name: 'notification-digest', level: env.LOG_LEVEL }),
  sendDigestEmail: notificationMail.sendDigest,
});

/* "Email me this project's standup" (migration 0108) — the same daily
   timer-in-`apps/api` placeholder as every sweep here, reusing
   `notificationMail`'s own queue rather than opening a fourth one: this is
   a sibling of the notification digest above, not a different concern. */
const standupDigestSweep = startStandupDigestSweep({
  logger: createLogger({ name: 'standup-digest', level: env.LOG_LEVEL }),
  mail: { queue: notificationMail.queue, webOrigin: env.WEB_ORIGIN },
});

/* The due-reminder sweep needs the sweep pool above. When the URL is unset,
   the starter warns and no-ops — the identical shape startBacklinksRelay
   uses. */
const dueReminderSweep = startDueReminderSweep({
  logger: createLogger({ name: 'due-reminders', level: env.LOG_LEVEL }),
});

/* Folds new docs.page_versions rows into docs.backlinks and emits
   page.content_updated (Phase 6 Wave 3, §3.10). Same "belongs in
   apps/worker" caveat as the audit relay above. */
const backlinksRelay = startBacklinksRelay({
  logger: createLogger({ name: 'backlinks-relay', level: env.LOG_LEVEL }),
});

/* Folds outbox events into search.documents (Phase 8 Wave 2, §2.2). Same
   "belongs in apps/worker" caveat as every relay above. */
const searchIndexRelay = startSearchIndexRelay({
  logger: createLogger({ name: 'search-index', level: env.LOG_LEVEL }),
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

/* Pulls call recordings off the carrier into this org's own object storage
   (Phase 7 Wave 2, ai/phase-7-voice.md §3.6). PLAN.md §8.5: "Recordings stored
   in your own object storage, never left on Twilio."

   Same "belongs in apps/worker" caveat as every sweep above — §7.1's re-asked
   decision at Wave 2 was to defer that deployable rather than stand one up for
   a single consumer. Off by default like the retention sweep, though this one
   is genuinely safe to run twice: its claim is a conditional UPDATE on
   `attempts`, so a second instance wastes carrier bandwidth rather than
   corrupting anything. */
const recordingIngest =
  env.RECORDING_INGEST_ENABLED && telephonyDeps?.storage !== undefined
    ? startRecordingIngest({
        logger: createLogger({ name: 'recording-ingest', level: env.LOG_LEVEL }),
        storage: telephonyDeps.storage,
        fetchRecording: createCarrierFetch({
          accountSid: env.TWILIO_ACCOUNT_SID ?? '',
          authToken: env.TWILIO_AUTH_TOKEN ?? '',
        }),
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
      searchIndexRelay.stop();
      digestSweep.stop();
      standupDigestSweep.stop();
      dueReminderSweep.stop();
      retention?.stop();
      recordingIngest?.stop();
      await app.close();
      await closeDatabase();
      process.exit(0);
    })();
  });
}
