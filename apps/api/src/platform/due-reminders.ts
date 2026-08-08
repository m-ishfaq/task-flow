import { and, inArray, isNotNull, isNull, lte, schema, withSweepScope } from '@taskflow/db';
import { newId } from '@taskflow/security';
import type { Logger } from '@taskflow/observability';
import { notificationPath } from './notification-paths.js';
import { planChannelDeliveries, type PendingPushSend } from './notification.projection.js';
import type { ExplicitPref } from './notification-prefs.js';

/**
 * The due-date reminder sweep (Phase 9 Wave 2, ai/phase-9-notifications.md §3.8).
 *
 * ## A scan, not an event
 *
 * "Due date approaching" is not a mutation — nothing emits an event when a
 * clock crosses a threshold — so this is a periodic scan of `work.cards`,
 * the same accepted timer-in-`apps/api` placeholder every other background
 * job uses, on an hourly cadence (a reminder does not need five-second
 * latency). The scan reads exactly the partial index `cards_due_idx` was
 * built for: due, unarchived, undeleted.
 *
 * ## Idempotent by the unique index, for free
 *
 * `notifications_event_user_key` on `(org_id, subject_id, user_id, kind)`
 * refuses a duplicate, so the sweep can run every hour against the same
 * still-due card forever and only ever write one reminder — via the same
 * `.onConflictDoNothing()` pattern the projection uses. This is also why the
 * sweep is safe to run in every API instance with no leader election: two
 * instances racing insert the same rows, and the second conflicts.
 *
 * ## The one gap, closed by the projection
 *
 * A reminder that already fired must be cleared when the card's due date is
 * edited, or the unique index keeps matching and no second reminder ever
 * fires. That clearing lives in `notification.projection.ts`'s
 * `dueDateChanged` handling, not here — see that file.
 *
 * ## Delivery rows are written here, by design
 *
 * The sweep is the ONLY writer of `card.due_soon` rows, and delivery
 * decisions are made at write time (§3.2). So for each new reminder it also
 * consults the recipient's preferences and writes the email/push/sms
 * delivery rows — email `pending` for the digest, push `pending` for the
 * relay, sms `suppressed` — exactly as the projection does for its own
 * kinds. This is the deliberate extension of §3.8's letter that migration
 * 0029's header documents: without it, a user who enabled `activity` email
 * would never see their due reminders in the daily digest, because no
 * pending delivery row would exist to collect.
 *
 * ## Runs as taskflow_notification_sweep
 *
 * The role migration 0029 grants exactly this job's reach: a column-limited
 * read of `work.cards` (never description or rank), SELECT on
 * `notification_prefs`, and SELECT/INSERT on `notifications` and
 * `notification_deliveries`.
 */

/** How far ahead a card is "due soon". Matches the plan's 24-hour window. */
const HORIZON_HOURS = 24;

export interface DueReminderResult {
  readonly scanned: number;
  readonly written: number;
  /** Push delivery rows awaiting the relay — returned so tests can assert. */
  readonly pendingPushes: readonly PendingPushSend[];
}

/** Runs one sweep pass. Injectable clock and horizon for tests. */
export async function runDueReminderSweep(
  now = new Date(),
  horizonHours = HORIZON_HOURS,
): Promise<DueReminderResult> {
  const cutoff = new Date(now.getTime() + horizonHours * 60 * 60 * 1000);

  return withSweepScope(async (tx) => {
    const dueCards = await tx
      .select({
        id: schema.cards.id,
        orgId: schema.cards.orgId,
        boardId: schema.cards.boardId,
        title: schema.cards.title,
        dueDate: schema.cards.dueDate,
        assigneeIds: schema.cards.assigneeIds,
      })
      .from(schema.cards)
      .where(
        and(
          isNotNull(schema.cards.dueDate),
          lte(schema.cards.dueDate, cutoff),
          isNull(schema.cards.archivedAt),
          isNull(schema.cards.deletedAt),
        ),
      );

    if (dueCards.length === 0) return { scanned: 0, written: 0, pendingPushes: [] };

    const assigneeIds = [...new Set(dueCards.flatMap((card) => card.assigneeIds))];
    const prefRows = await tx
      .select({
        userId: schema.notificationPrefs.userId,
        category: schema.notificationPrefs.category,
        channel: schema.notificationPrefs.channel,
        enabled: schema.notificationPrefs.enabled,
      })
      .from(schema.notificationPrefs)
      .where(inArray(schema.notificationPrefs.userId, assigneeIds));
    const prefsByUser = new Map<string, ExplicitPref[]>();
    for (const pref of prefRows) {
      const list = prefsByUser.get(pref.userId) ?? [];
      list.push({
        category: pref.category as ExplicitPref['category'],
        channel: pref.channel as ExplicitPref['channel'],
        enabled: pref.enabled,
      });
      prefsByUser.set(pref.userId, list);
    }

    let written = 0;
    const pendingPushes: PendingPushSend[] = [];

    for (const card of dueCards) {
      for (const assigneeId of card.assigneeIds) {
        /* `assignee_ids` is `uuid[] NOT NULL` — elements are always uuids, so
           no undefined check here; the column type is the source of truth. */
        const inserted = await tx
          .insert(schema.notifications)
          .values({
            id: newId<'NotificationId'>(),
            orgId: card.orgId,
            userId: assigneeId,
            kind: 'card.due_soon',
            subjectType: 'card',
            subjectId: card.id,
            boardId: card.boardId,
            title: `Due soon: ${card.title}`,
            excerpt: null,
            actorId: null,
          })
          /* The idempotency mechanism — see the file header. A card already
             reminded (or a redelivered batch) conflicts here and is skipped. */
          .onConflictDoNothing()
          .returning({ id: schema.notifications.id });

        const notificationId = inserted[0]?.id;
        if (notificationId === undefined) continue;
        written += 1;

        const deliveries = planChannelDeliveries('card.due_soon', prefsByUser.get(assigneeId) ?? []);
        const path = notificationPath({
          subjectType: 'card',
          subjectId: card.id,
          channelId: null,
          boardId: card.boardId,
        });

        if (deliveries.email !== 'off' && path !== null) {
          await tx
            .insert(schema.notificationDeliveries)
            .values({
              id: newId<'NotificationDeliveryId'>(),
              orgId: card.orgId,
              userId: assigneeId,
              notificationId,
              channel: 'email',
              status: 'pending',
            })
            .onConflictDoNothing();
        }

        if (deliveries.push && path !== null) {
          const deliveryId = newId<'NotificationDeliveryId'>();
          await tx
            .insert(schema.notificationDeliveries)
            .values({
              id: deliveryId,
              orgId: card.orgId,
              userId: assigneeId,
              notificationId,
              channel: 'push',
              status: 'pending',
            })
            .onConflictDoNothing();
          pendingPushes.push({
            deliveryId,
            userId: assigneeId,
            title: `Due soon: ${card.title}`,
            excerpt: null,
            path,
          });
        }

        if (deliveries.sms) {
          await tx
            .insert(schema.notificationDeliveries)
            .values({
              id: newId<'NotificationDeliveryId'>(),
              orgId: card.orgId,
              userId: assigneeId,
              notificationId,
              channel: 'sms',
              status: 'suppressed',
              reason: 'no_provider',
            })
            .onConflictDoNothing();
        }
      }
    }

    return { scanned: dueCards.length, written, pendingPushes };
  });
}

/** One hour — see the file header on why not shorter. */
const TICK_MS = 60 * 60 * 1000;

export interface DueReminderSweepHandle {
  readonly stop: () => void;
}

export interface StartDueReminderSweepOptions {
  readonly logger: Logger;
  readonly intervalMs?: number;
}

/**
 * Starts the sweep, or does nothing if no sweep connection was configured —
 * mirroring `startBacklinksRelay`: an API instance without
 * `DATABASE_NOTIFICATION_SWEEP_URL` is a valid deployment (another process
 * runs the job), and what must never happen silently is the narrow role's
 * grant being bypassed by a fallback to the application role.
 */
export function startDueReminderSweep(options: StartDueReminderSweepOptions): DueReminderSweepHandle {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await runDueReminderSweep();
      if (result.written > 0) {
        options.logger.info(
          { scanned: result.scanned, written: result.written },
          'due-reminder sweep wrote reminders',
        );
      }
    } catch (error) {
      // Logged, never rethrown — the identical reasoning startAuditRelay gives.
      options.logger.error({ err: error }, 'due-reminder sweep failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? TICK_MS);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
