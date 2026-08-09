import { and, eq, inArray, schema, withAuditScope } from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { ACTIVITY_KINDS } from './notification-prefs.js';
import { notificationPath } from './notification-paths.js';

/**
 * The daily digest (Phase 9 Wave 2, ai/phase-9-notifications.md §3.4).
 *
 * ## A digest batches DELIVERY, never the record
 *
 * The `platform.notifications` row was written the moment the activity
 * happened, by the projection or the due-reminder sweep — nothing about that
 * changes. What this sweep batches is the EMAIL channel: it collects the
 * `activity`-category rows that are still `pending` in
 * `notification_deliveries`, sends ONE email per user covering all of them,
 * and marks every covered delivery `sent` in one pass.
 *
 * "Since the last digest" needs no cursor: the rows are pending BECAUSE no
 * digest has collected them yet. Marking them sent is the cursor.
 *
 * ## Direct category never sits here
 *
 * The query filters on `ACTIVITY_KINDS`, derived from the same closed table
 * `categoryOfKind` reads. A `direct` mention that the relay has not sent yet
 * (mailer briefly down) must NOT be swept into tomorrow's digest — a mention
 * arriving late defeats the point of mentioning someone. The filter is what
 * keeps the two apart.
 *
 * ## Runs as taskflow_audit
 *
 * Like the projection, the digest must see pending rows across every org in
 * one pass, and it holds exactly the grants that requires (0027's SELECT and
 * UPDATE on `notification_deliveries`, 0022's SELECT on `notifications`, and
 * the column-limited `identity.users` read for addresses).
 */

const BATCH = 500;

export interface DigestItem {
  readonly title: string;
  readonly excerpt: string | null;
  readonly path: string;
}

export interface DigestBatch {
  readonly to: string;
  readonly items: readonly DigestItem[];
  /** The delivery rows this batch covers, marked `sent` only after the send. */
  readonly deliveryIds: readonly string[];
}

/**
 * Reads the next batch of pending activity-email deliveries, grouped by
 * recipient into digest batches. Pure read — the caller sends, then marks.
 */
export async function collectDigestBatches(limit = BATCH): Promise<readonly DigestBatch[]> {
  return withAuditScope(async (tx) => {
    const rows = await tx
      .select({
        deliveryId: schema.notificationDeliveries.id,
        userId: schema.notificationDeliveries.userId,
        orgId: schema.notificationDeliveries.orgId,
        kind: schema.notifications.kind,
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
      /* Phase 12 Wave 1 §3.9: a delivery decided BEFORE the org was
         suspended must not ride the next digest while it is suspended. The
         join is the filter; reactivation lets the pending rows flow again.
         Runs as taskflow_audit with the column-limited orgs read migration
         0037 grants. */
      .innerJoin(
        schema.orgs,
        and(
          eq(schema.orgs.id, schema.notificationDeliveries.orgId),
          eq(schema.orgs.status, 'active'),
        ),
      )
      .where(
        and(
          eq(schema.notificationDeliveries.channel, 'email'),
          eq(schema.notificationDeliveries.status, 'pending'),
          inArray(schema.notifications.kind, [...ACTIVITY_KINDS]),
        ),
      )
      .limit(limit);

    if (rows.length === 0) return [];

    // Group by recipient; one email per person, ordered oldest first so the
    // digest reads the way the day happened.
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }

    const userIds = [...byUser.keys()];
    const addresses = await tx
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds));
    const emailByUserId = new Map(addresses.map((user) => [user.id, user.email]));

    const batches: DigestBatch[] = [];
    for (const [userId, userRows] of byUser) {
      const to = emailByUserId.get(userId);
      if (to === undefined) continue; // No address: nothing to send to.

      const items: DigestItem[] = [];
      const deliveryIds: string[] = [];
      for (const row of userRows) {
        const path = notificationPath({
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          channelId: row.channelId,
          boardId: row.boardId,
        });
        if (path === null) continue;
        items.push({ title: row.title, excerpt: row.excerpt, path });
        deliveryIds.push(row.deliveryId);
      }
      if (items.length === 0) continue;

      batches.push({ to, items, deliveryIds });
    }
    return batches;
  });
}

/**
 * Marks a batch's deliveries `sent` — called only after the email was handed
 * to the mailer, so a crash between the send and the mark leaves the rows
 * pending and the next digest retries them (at-least-once, the same contract
 * the projection and push relay already run on).
 */
export async function markDigestSent(deliveryIds: readonly string[]): Promise<void> {
  if (deliveryIds.length === 0) return;
  await withAuditScope(async (tx) => {
    await tx
      .update(schema.notificationDeliveries)
      .set({ status: 'sent', updatedAt: new Date() })
      .where(
        and(
          inArray(schema.notificationDeliveries.id, [...deliveryIds]),
          eq(schema.notificationDeliveries.status, 'pending'),
        ),
      );
  });
}

/**
 * Drives the digest sweep on a daily timer — the same accepted
 * timer-in-the-API placeholder `tenancy/relay.ts` documents for the audit
 * relay. Safe to run in every instance: two ticks may both READ the same
 * pending rows, but `markDigestSent`'s conditional update means only the
 * first to mark claims them, and the worst duplicate is two nearly-identical
 * digest emails on the day a second instance starts.
 */
export interface DigestSweepHandle {
  readonly stop: () => void;
}

export interface StartDigestSweepOptions {
  readonly logger: Logger;
  /** Hands one rendered digest to a mailer. Synchronous and non-blocking. */
  readonly sendDigestEmail: (batch: DigestBatch) => void;
  readonly intervalMs?: number;
}

/** One day — the single daily cadence §3.4 scopes for Wave 1 (§7.2). */
const DAILY_MS = 24 * 60 * 60 * 1000;

export function startDigestSweep(options: StartDigestSweepOptions): DigestSweepHandle {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const batches = await collectDigestBatches();
      if (batches.length === 0) return;
      for (const batch of batches) {
        options.sendDigestEmail(batch);
        await markDigestSent(batch.deliveryIds);
      }
      options.logger.info(
        {
          batches: batches.length,
          deliveries: batches.reduce((n, b) => n + b.deliveryIds.length, 0),
        },
        'digest sweep sent activity email',
      );
    } catch (error) {
      // Logged, never rethrown — the identical reasoning startAuditRelay gives.
      options.logger.error({ err: error }, 'digest sweep failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? DAILY_MS);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
