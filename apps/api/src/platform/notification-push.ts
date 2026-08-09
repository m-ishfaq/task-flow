import { and, eq, inArray, schema, withAuditScope } from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { notificationPath } from './notification-paths.js';
import type { PushProvider, PushSendOutcome } from './push-provider.js';

/**
 * Sends every pending push delivery (Phase 9 Wave 2, ai/phase-9-notifications.md
 * §3.7).
 *
 * ## One drain for two writers
 *
 * Push delivery rows are written `pending` by two different producers: the
 * notification projection (event-driven kinds) and the due-reminder sweep
 * (`card.due_soon`). Both leave the row for THIS function, which runs on the
 * relay's tick whenever a provider is configured — so there is exactly one
 * place that turns a `pending` push row into a network send, and neither
 * writer needs to know the other exists.
 *
 * ## Sends happen outside the transaction that read the rows
 *
 * The same discipline the email path already uses (`notification.projection.ts`'s
 * header): read pending rows and their subscriptions in one transaction, then
 * POST — a database transaction must not hold a network call — then mark the
 * outcomes in follow-up transactions.
 *
 * ## At-least-once, and the one window that is genuinely at-least-once
 *
 * A crash between the send and the mark leaves the row `pending`, so the next
 * tick sends it again. That is the same at-least-once contract the whole
 * notification pipeline already has (the outbox's redelivery, the email
 * queue's retry), accepted here for the identical reason: the alternative is
 * a row that is silently never sent. The mark itself is conditional on
 * `status = 'pending'`, so two ticks that both sent cannot both claim the
 * same delivery; the second UPDATE matches nothing.
 */

const BATCH = 100;

export interface PendingPushRow {
  readonly deliveryId: string;
  readonly userId: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly path: string | null;
}

export interface PushDrainResult {
  attempted: number;
  sent: number;
  failed: number;
  gone: number;
}

/** Reads the next batch of pending push rows, with their notification content. */
async function readPendingPushRows(): Promise<PendingPushRow[]> {
  return withAuditScope(async (tx) => {
    const rows = await tx
      .select({
        deliveryId: schema.notificationDeliveries.id,
        userId: schema.notificationDeliveries.userId,
        subjectType: schema.notifications.subjectType,
        subjectId: schema.notifications.subjectId,
        channelId: schema.notifications.channelId,
        boardId: schema.notifications.boardId,
        title: schema.notifications.title,
        excerpt: schema.notifications.excerpt,
      })
      .from(schema.notificationDeliveries)
      .innerJoin(
        schema.notifications,
        eq(schema.notifications.id, schema.notificationDeliveries.notificationId),
      )
      /* Phase 12 §3.9: a suspended org's members stop receiving push while
         suspended. `taskflow_audit`'s grant on `identity.orgs` is
         column-limited to `(id, status)` — migration 0032. */
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.notificationDeliveries.orgId))
      .where(
        and(
          eq(schema.notificationDeliveries.channel, 'push'),
          eq(schema.notificationDeliveries.status, 'pending'),
          eq(schema.orgs.status, 'active'),
        ),
      )
      .limit(BATCH);

    return rows.map((row) => ({
      deliveryId: row.deliveryId,
      userId: row.userId,
      title: row.title,
      excerpt: row.excerpt,
      path: notificationPath({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        channelId: row.channelId,
        boardId: row.boardId,
      }),
    }));
  });
}

/** Sends one batch of pending pushes. Returns how many went where, for logging. */
export async function deliverPendingPushes(
  provider: PushProvider,
  logger: Logger,
): Promise<PushDrainResult> {
  const pending = await readPendingPushRows();
  if (pending.length === 0) return { attempted: 0, sent: 0, failed: 0, gone: 0 };

  /* Subscriptions are global per user — one read per distinct recipient in
     the batch, as taskflow_audit (the only role that may read across every
     user's rows; migration 0029's `push_subscriptions_audit_send`). */
  const userIds = [...new Set(pending.map((row) => row.userId))];
  const subscriptions = await withAuditScope(async (tx) =>
    tx
      .select({
        id: schema.pushSubscriptions.id,
        userId: schema.pushSubscriptions.userId,
        endpoint: schema.pushSubscriptions.endpoint,
        p256dh: schema.pushSubscriptions.p256dh,
        auth: schema.pushSubscriptions.auth,
      })
      .from(schema.pushSubscriptions)
      .where(inArray(schema.pushSubscriptions.userId, userIds)),
  );
  const byUser = new Map<string, typeof subscriptions>();
  for (const subscription of subscriptions) {
    const list = byUser.get(subscription.userId) ?? [];
    list.push(subscription);
    byUser.set(subscription.userId, list);
  }

  const result: PushDrainResult = { attempted: 0, sent: 0, failed: 0, gone: 0 };
  const sentIds: string[] = [];
  const sentUserIds: string[] = [];
  const failedIds: string[] = [];
  const deadSubscriptionIds: string[] = [];

  for (const row of pending) {
    if (row.path === null) {
      /* Cannot link, so nothing to push — the in-app row already exists, and
         a push that cannot open anywhere would be worse than none. Marked
         failed so it does not sit pending forever. */
      failedIds.push(row.deliveryId);
      continue;
    }

    const forUser = byUser.get(row.userId) ?? [];
    if (forUser.length === 0) {
      /* Push is on but no device is registered — the ceremony never finished
         or every device unregistered. There is nothing to send to, and
         retrying every tick is a guaranteed-fail loop, so it is marked
         failed with this comment instead. The pref page's state is the
         thing to fix, not this row. */
      failedIds.push(row.deliveryId);
      continue;
    }

    const payload = JSON.stringify({ title: row.title, body: row.excerpt, path: row.path });

    for (const subscription of forUser) {
      result.attempted += 1;
      let outcome: PushSendOutcome;
      try {
        outcome = await provider.send({
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          payload,
        });
      } catch (error) {
        // Transient — the row stays pending and the next tick retries.
        logger.warn({ err: error, deliveryId: row.deliveryId }, 'push send failed (transient)');
        outcome = 'failed';
        break;
      }

      if (outcome === 'sent') {
        result.sent += 1;
        sentIds.push(row.deliveryId);
        sentUserIds.push(row.userId);
        continue;
      }
      if (outcome === 'gone') {
        // 404/410 — the browser will never use this endpoint again.
        result.gone += 1;
        deadSubscriptionIds.push(subscription.id);
        failedIds.push(row.deliveryId);
        continue;
      }
      result.failed += 1;
      failedIds.push(row.deliveryId);
    }
  }

  await markOutcomes(sentIds, sentUserIds, failedIds, deadSubscriptionIds);
  return result;
}

/** Marks outcomes in follow-up transactions — never inside a network call. */
async function markOutcomes(
  sentIds: readonly string[],
  sentUserIds: readonly string[],
  failedIds: readonly string[],
  deadSubscriptionIds: readonly string[],
): Promise<void> {
  await withAuditScope(async (tx) => {
    if (sentIds.length > 0) {
      await tx
        .update(schema.notificationDeliveries)
        .set({ status: 'sent', updatedAt: new Date() })
        .where(
          and(
            inArray(schema.notificationDeliveries.id, [...sentIds]),
            eq(schema.notificationDeliveries.status, 'pending'),
          ),
        );
    }
    if (failedIds.length > 0) {
      await tx
        .update(schema.notificationDeliveries)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(
          and(
            inArray(schema.notificationDeliveries.id, [...failedIds]),
            eq(schema.notificationDeliveries.status, 'pending'),
          ),
        );
    }
  });

  /* last_seen_at rides the success path — Phase 12's "is this device alive"
     question, answered by the relay that is already here. Keyed on the USER
     whose deliveries succeeded, not the delivery ids: the column is on the
     subscription rows, and every subscription of a user who got one message
     is alive by definition. */
  if (sentUserIds.length > 0) {
    await withAuditScope(async (tx) => {
      await tx
        .update(schema.pushSubscriptions)
        .set({ lastSeenAt: new Date() })
        .where(inArray(schema.pushSubscriptions.userId, [...new Set(sentUserIds)]));
    });
  }

  if (deadSubscriptionIds.length > 0) {
    await withAuditScope(async (tx) => {
      await tx
        .delete(schema.pushSubscriptions)
        .where(inArray(schema.pushSubscriptions.id, [...deadSubscriptionIds]));
    });
  }
}
