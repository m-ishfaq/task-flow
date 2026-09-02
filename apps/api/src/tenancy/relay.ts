import { hasAuditDatabase } from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { drainOutboxFully } from './audit.projection.js';
import {
  drainNotificationsFully,
  markEmailDeliveries,
  type PendingEmailSend,
} from '../platform/notification.projection.js';
import { deliverPendingPushes } from '../platform/notification-push.js';
import { drainCallWakeFully } from '../platform/call-wake.js';
import { tickAnalytics } from '../analytics/projection.relay.js';
import type { ExpoPushProvider, PushProvider } from '../platform/push-provider.js';

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
  /**
   * Hands one decided notification email to a mailer (Phase 9,
   * ai/phase-9-notifications.md §3.6). Synchronous and non-blocking by
   * contract — the same shape `MailQueue.enqueue` already has, for the
   * identical timing reason `identity/deliver.ts` never awaits mail from a
   * request. Omitted in tests and in any deployment with no mail transport
   * configured; deliveries then stay `pending` rather than being guessed at.
   */
  readonly sendNotificationEmail?: (send: PendingEmailSend) => void;
  /**
   * The web push provider (Phase 9 Wave 2, §3.7), when VAPID keys are
   * configured. When present, every tick drains the pending push delivery
   * rows — written by both the projection and the due-reminder sweep — via
   * `deliverPendingPushes`. Omitted (and rows stay `pending`) when the
   * server has no keys: push is genuinely off, and the preferences page says
   * so.
   */
  readonly pushProvider?: PushProvider;
  /**
   * The native mobile push provider (Phase 14 §9), independent of
   * `pushProvider` — a deployment can run with either, both, or neither
   * configured. When present, the same tick also drains devices registered
   * through `expoPush.register`. Unlike web push, `ExpoPushProvider` needs
   * no server-held key material to construct (see that class's own header),
   * so this is not gated on an env var the way `pushProvider` is on VAPID
   * keys.
   */
  readonly expoPushProvider?: ExpoPushProvider;
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

      /* The notification projection rides the same tick but claims under its
         OWN consumer name (migration 0015), so it drains the same rows
         independently — one falling behind or erroring never starves the
         other, and neither marks the other's rows done.

         Awaited AFTER audit rather than in parallel: audit is the compliance
         record and gets the database first if they contend. A notification
         arriving a tick late is not a defect; an audit entry doing so is the
         thing this relay exists to prevent. */
      const notified = await drainNotificationsFully(100, 50, options.logger);
      if (notified.written > 0) {
        options.logger.debug({ written: notified.written }, 'notification projection wrote rows');
      }

      /* Emails the projection decided to send (Phase 9). Sent OUTSIDE the
         projection's own transaction — see notification.projection.ts's file
         header — and marked `sent` in a follow-up transaction only after the
         mailer has accepted each one, never before. If no mailer is
         configured, deliveries stay `pending`: the next tick tries again,
         which is the correct behaviour for "not yet sent" rather than a
         silent drop. */
      if (notified.pendingEmails.length > 0 && options.sendNotificationEmail) {
        const sent: string[] = [];
        for (const send of notified.pendingEmails) {
          options.sendNotificationEmail(send);
          sent.push(send.deliveryId);
        }
        await markEmailDeliveries(sent, 'sent');
      }

      /* Push rows written `pending` by either producer — the projection or
         the due-reminder sweep — are sent here, on the same tick, whenever
         AT LEAST ONE provider exists (web, native, or both — see
         `deliverPendingPushes`'s own header on why a single row can fan out
         to both channels). At-least-once by design; see
         `notification-push.ts` on the crash window and why the mark is
         conditional. */
      if (options.pushProvider || options.expoPushProvider) {
        /* `exactOptionalPropertyTypes` refuses an explicit `undefined` for
           an optional property (the same rule `main.ts`'s own comment
           names for `pushProvider` there) — each key is included only when
           its provider actually exists, never present-and-undefined. */
        const pushed = await deliverPendingPushes(
          {
            ...(options.pushProvider === undefined ? {} : { web: options.pushProvider }),
            ...(options.expoPushProvider === undefined ? {} : { expo: options.expoPushProvider }),
          },
          options.logger,
        );
        if (pushed.attempted > 0) {
          options.logger.debug(
            {
              attempted: pushed.attempted,
              sent: pushed.sent,
              failed: pushed.failed,
              gone: pushed.gone,
            },
            'push relay delivered notifications',
          );
        }
      }

      /* Rings a phone that is backgrounded or fully killed (Phase 14, Tier 3
         Pass B — see call-wake.ts's own header). Drains `rtc_session.started`
         under its OWN consumer name, same tick, same reasoning as every other
         consumer here: one falling behind or erroring never starves another.
         Gated on `expoPushProvider` alone, not `pushProvider` — this is a
         mobile-only concern with no web-push equivalent (a browser tab
         already gets the live ring over the socket, same as an alive mobile
         app does). */
      if (options.expoPushProvider) {
        const woken = await drainCallWakeFully(options.expoPushProvider, options.logger);
        if (woken.attempted > 0) {
          options.logger.debug(
            { attempted: woken.attempted, sent: woken.sent },
            'call-wake relay sent ring pushes',
          );
        }
      }

      /* The analytics transitions projection (Phase 11) rides the same tick
         under its OWN consumer name ('analytics', migration 0091), claiming as
         taskflow_audit — see analytics/projection.relay.ts's header. `tickAnalytics`
         wraps its own try/catch so a projection error can never cascade into
         the consumers above it (migration 0088's outage is the lesson), and it
         needs no provider or extra config, so it always runs. */
      await tickAnalytics(options.logger);
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
