import { and, eq, inArray, schema, withAuditScope } from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { notificationPath } from './notification-paths.js';
import type { ExpoPushProvider, PushProvider, PushSendOutcome } from './push-provider.js';

/**
 * Sends every pending push delivery (Phase 9 Wave 2, ai/phase-9-notifications.md
 * §3.7; native mobile push added Phase 14 §9, ai/phase-14-mobile.md).
 *
 * ## One drain for two writers, and now two DESTINATIONS
 *
 * Push delivery rows are written `pending` by two different producers: the
 * notification projection (event-driven kinds) and the due-reminder sweep
 * (`card.due_soon`). Both leave the row for THIS function, which runs on the
 * relay's tick whenever at least one provider is configured — so there is
 * exactly one place that turns a `pending` push row into a network send,
 * and neither writer needs to know the other exists.
 *
 * A single delivery row now fans out to BOTH a person's web subscriptions
 * and their native devices, whichever exist — someone signed in on a
 * browser and a phone gets the message on both, not a single channel
 * arbitrarily chosen. The `web`/`expo` providers are independently
 * optional: a deployment can run with neither, either, or both configured,
 * and the drain sends to whichever provider IS present for whichever
 * devices a person HAS. A row is only marked `failed` for "nothing to send
 * to" once NEITHER channel found a destination — see the per-row loop.
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
      /* Phase 12 Wave 1 §3.9: a push decided before the org was suspended
         must not leave the system after it is. The join is the filter — the
         row stays pending, and reactivation resumes it. Runs as
         taskflow_audit with the column-limited orgs read migration 0037
         grants. */
      .innerJoin(
        schema.orgs,
        and(
          eq(schema.orgs.id, schema.notificationDeliveries.orgId),
          eq(schema.orgs.status, 'active'),
        ),
      )
      .where(
        and(
          eq(schema.notificationDeliveries.channel, 'push'),
          eq(schema.notificationDeliveries.status, 'pending'),
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

export interface PushProviders {
  readonly web?: PushProvider;
  readonly expo?: ExpoPushProvider;
}

/** Sends one batch of pending pushes, to every configured channel a person has a device on. Returns how many went where, for logging. */
export async function deliverPendingPushes(
  providers: PushProviders,
  logger: Logger,
): Promise<PushDrainResult> {
  const pending = await readPendingPushRows();
  if (pending.length === 0) return { attempted: 0, sent: 0, failed: 0, gone: 0 };

  const userIds = [...new Set(pending.map((row) => row.userId))];

  /* Subscriptions/tokens are global per user — one read per distinct
     recipient in the batch, as taskflow_audit (the only role that may read
     across every user's rows; migrations 0029/0082's own `_audit_send`
     policies). Each read is skipped entirely when its provider is not
     configured — no point reading rows nothing will ever send to. */
  const webByUser = new Map<
    string,
    { id: string; endpoint: string; p256dh: string; auth: string }[]
  >();
  if (providers.web !== undefined) {
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
    for (const subscription of subscriptions) {
      const list = webByUser.get(subscription.userId) ?? [];
      list.push(subscription);
      webByUser.set(subscription.userId, list);
    }
  }

  const expoByUser = new Map<string, { id: string; expoPushToken: string }[]>();
  if (providers.expo !== undefined) {
    const tokens = await withAuditScope(async (tx) =>
      tx
        .select({
          id: schema.expoPushTokens.id,
          userId: schema.expoPushTokens.userId,
          expoPushToken: schema.expoPushTokens.expoPushToken,
        })
        .from(schema.expoPushTokens)
        .where(inArray(schema.expoPushTokens.userId, userIds)),
    );
    for (const token of tokens) {
      const list = expoByUser.get(token.userId) ?? [];
      list.push(token);
      expoByUser.set(token.userId, list);
    }
  }

  const result: PushDrainResult = { attempted: 0, sent: 0, failed: 0, gone: 0 };
  const sentIds: string[] = [];
  const sentWebUserIds: string[] = [];
  const sentExpoUserIds: string[] = [];
  const failedIds: string[] = [];
  const deadSubscriptionIds: string[] = [];
  const deadExpoTokenIds: string[] = [];

  for (const row of pending) {
    if (row.path === null) {
      /* Cannot link, so nothing to push — the in-app row already exists, and
         a push that cannot open anywhere would be worse than none. Marked
         failed so it does not sit pending forever. */
      failedIds.push(row.deliveryId);
      continue;
    }

    const webDevices = webByUser.get(row.userId) ?? [];
    const expoDevices = expoByUser.get(row.userId) ?? [];
    if (webDevices.length === 0 && expoDevices.length === 0) {
      /* Push is on but no device is registered on EITHER channel — the
         ceremony never finished or every device unregistered. There is
         nothing to send to, and retrying every tick is a guaranteed-fail
         loop, so it is marked failed with this comment instead. The pref
         page's state is the thing to fix, not this row. */
      failedIds.push(row.deliveryId);
      continue;
    }

    let rowSent = false;
    // Set on a THROWN (transient) error, on either channel — mirrors the
    // single-channel version's `break`-on-throw: a transport failure means
    // "try this row again next tick," so the row must stay `pending`
    // (pushed to neither `sentIds` nor `failedIds`) rather than being
    // marked a definitive failure. Tracked separately from `rowSent`
    // because a channel that already succeeded still counts as sent even
    // if a DIFFERENT channel then throws — see the comment below the loops.
    let rowHadTransientError = false;

    if (providers.web !== undefined) {
      const payload = JSON.stringify({ title: row.title, body: row.excerpt, path: row.path });
      for (const subscription of webDevices) {
        result.attempted += 1;
        let outcome: PushSendOutcome;
        try {
          outcome = await providers.web.send({
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
            payload,
          });
        } catch (error) {
          // Transient — stop trying this channel's remaining devices for
          // this row; the row itself stays pending unless another channel
          // below succeeds.
          logger.warn({ err: error, deliveryId: row.deliveryId }, 'push send failed (transient)');
          rowHadTransientError = true;
          break;
        }

        if (outcome === 'sent') {
          result.sent += 1;
          rowSent = true;
          sentWebUserIds.push(row.userId);
        } else if (outcome === 'gone') {
          // 404/410 — the browser will never use this endpoint again.
          result.gone += 1;
          deadSubscriptionIds.push(subscription.id);
        } else {
          result.failed += 1;
        }
      }
    }

    if (providers.expo !== undefined) {
      for (const device of expoDevices) {
        result.attempted += 1;
        let outcome: PushSendOutcome;
        try {
          outcome = await providers.expo.send({
            expoPushToken: device.expoPushToken,
            title: row.title,
            body: row.excerpt,
            path: row.path,
          });
        } catch (error) {
          logger.warn(
            { err: error, deliveryId: row.deliveryId },
            'expo push send failed (transient)',
          );
          rowHadTransientError = true;
          break;
        }

        if (outcome === 'sent') {
          result.sent += 1;
          rowSent = true;
          sentExpoUserIds.push(row.userId);
        } else if (outcome === 'gone') {
          // Expo's "DeviceNotRegistered" — the app was uninstalled, or the
          // token rotated past what this row remembers.
          result.gone += 1;
          deadExpoTokenIds.push(device.id);
        } else {
          result.failed += 1;
        }
      }
    }

    /* One delivery, fanned out to every device on every configured channel.
       "Sent" the moment ANY of them succeeded — a person who sees the
       notification on their phone does not need it retried at their
       browser too, even if a DIFFERENT channel then hit a transient error:
       marking the row pending again would re-send to the channel that
       already delivered it. Only when NOTHING succeeded does a transient
       error matter — then the row is left off both lists (stays `pending`,
       the next tick retries) rather than being marked a definitive
       failure, the same distinction the single-channel version's
       break-then-no-push made. */
    if (rowSent) sentIds.push(row.deliveryId);
    else if (!rowHadTransientError) failedIds.push(row.deliveryId);
  }

  await markOutcomes({
    sentIds,
    sentWebUserIds,
    sentExpoUserIds,
    failedIds,
    deadSubscriptionIds,
    deadExpoTokenIds,
  });
  return result;
}

/** Marks outcomes in follow-up transactions — never inside a network call. */
async function markOutcomes(input: {
  readonly sentIds: readonly string[];
  readonly sentWebUserIds: readonly string[];
  readonly sentExpoUserIds: readonly string[];
  readonly failedIds: readonly string[];
  readonly deadSubscriptionIds: readonly string[];
  readonly deadExpoTokenIds: readonly string[];
}): Promise<void> {
  await withAuditScope(async (tx) => {
    if (input.sentIds.length > 0) {
      await tx
        .update(schema.notificationDeliveries)
        .set({ status: 'sent', updatedAt: new Date() })
        .where(
          and(
            inArray(schema.notificationDeliveries.id, [...input.sentIds]),
            eq(schema.notificationDeliveries.status, 'pending'),
          ),
        );
    }
    if (input.failedIds.length > 0) {
      await tx
        .update(schema.notificationDeliveries)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(
          and(
            inArray(schema.notificationDeliveries.id, [...input.failedIds]),
            eq(schema.notificationDeliveries.status, 'pending'),
          ),
        );
    }
  });

  /* last_seen_at rides the success path — Phase 12's "is this device alive"
     question, answered by the relay that is already here. Keyed on the USER
     whose deliveries succeeded on THAT channel, not the delivery ids: the
     column is on the subscription/token rows, and every device of a user
     who got one message on that channel is alive by definition. */
  if (input.sentWebUserIds.length > 0) {
    await withAuditScope(async (tx) => {
      await tx
        .update(schema.pushSubscriptions)
        .set({ lastSeenAt: new Date() })
        .where(inArray(schema.pushSubscriptions.userId, [...new Set(input.sentWebUserIds)]));
    });
  }
  if (input.sentExpoUserIds.length > 0) {
    await withAuditScope(async (tx) => {
      await tx
        .update(schema.expoPushTokens)
        .set({ lastSeenAt: new Date() })
        .where(inArray(schema.expoPushTokens.userId, [...new Set(input.sentExpoUserIds)]));
    });
  }

  if (input.deadSubscriptionIds.length > 0) {
    await withAuditScope(async (tx) => {
      await tx
        .delete(schema.pushSubscriptions)
        .where(inArray(schema.pushSubscriptions.id, [...input.deadSubscriptionIds]));
    });
  }
  if (input.deadExpoTokenIds.length > 0) {
    await withAuditScope(async (tx) => {
      await tx
        .delete(schema.expoPushTokens)
        .where(inArray(schema.expoPushTokens.id, [...input.deadExpoTokenIds]));
    });
  }
}
