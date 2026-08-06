import {
  and,
  claimPending,
  eq,
  markDispatched,
  schema,
  withAuditScope,
  type OutboxRow,
} from '@taskflow/db';
import { newId } from '@taskflow/security';

/**
 * Turning chat events into notifications (PLAN.md §10.6; ai/phase-5-chat.md §4).
 *
 * ## A third consumer, not a second mechanism
 *
 * Migration 0015 gave the outbox a claim per CONSUMER (`outbox_dispatch`), so
 * `audit` and `realtime` already drain the same rows independently and neither
 * starves the other. This is the third name. Nothing new was needed, which is
 * the point of that migration — and the reason a notification falling behind
 * cannot delay an audit entry.
 *
 * ## At-least-once, and made idempotent by a unique index
 *
 * Unlike the audit projection, this one does NOT get exactly-once: it claims,
 * writes, and marks in one transaction, but a crash between the write and the
 * mark redelivers the batch. `notifications_event_user_key` is what makes that
 * harmless — a redelivered event conflicts on (org, subject, user, kind) and is
 * ignored rather than ringing somebody's bell twice.
 *
 * That is the normal outbox contract (CLAUDE.md: "later consumers get
 * at-least-once and must be idempotent"). Audit is the exception, not this.
 *
 * ## Nobody is notified about their own message
 *
 * The most common bug in this shape, and the one that makes a notification
 * system feel broken rather than wrong: you @mention a colleague, and you get
 * the notification too because you are a participant in the conversation. Every
 * branch below excludes `row.actorId`.
 *
 * ## The excerpt is a SNAPSHOT, deliberately
 *
 * `title` and `excerpt` are written here and never re-read from the message.
 * Two reasons, and the second is the one that matters: a notification must
 * survive its message being deleted by retention, and rendering a list of fifty
 * notifications must not re-read fifty channels the reader may have since been
 * removed from. What is stored is what they were entitled to see at the moment
 * they were told.
 */

/** The consumer name this projection claims under. */
export const NOTIFICATION_CONSUMER = 'notifications';

export interface NotificationDrainResult {
  readonly processed: number;
  readonly written: number;
}

interface PlannedNotification {
  readonly userId: string;
  readonly kind: 'chat.mention' | 'chat.direct' | 'chat.thread_reply';
  readonly title: string;
  readonly excerpt: string | null;
}

/**
 * What one event should tell whom.
 *
 * Pure, and separated from the write so it can be tested without a database —
 * "who gets told about this" is the whole logic, and it is worth being able to
 * assert directly.
 */
export function planNotifications(row: OutboxRow): readonly PlannedNotification[] {
  if (row.name !== 'message.sent') return [];

  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return [];

  const fields = payload as {
    readonly mentionedUserIds?: unknown;
    readonly excerpt?: unknown;
    readonly channelName?: unknown;
    readonly parentAuthorId?: unknown;
    readonly directRecipientIds?: unknown;
  };

  const excerpt = typeof fields.excerpt === 'string' ? fields.excerpt : null;
  const channelName = typeof fields.channelName === 'string' ? fields.channelName : null;

  /* Deduplicated ACROSS kinds, not just within one. Somebody mentioned in a
     reply to their own message in a DM would otherwise get three rows for one
     message — and the unique index would reject two of them, turning a
     cosmetic problem into a failed batch. First kind wins, in priority order:
     a mention is more specific than a thread reply, which is more specific
     than "a message arrived". */
  const told = new Set<string>();
  const planned: PlannedNotification[] = [];

  const add = (userId: string, kind: PlannedNotification['kind'], title: string): void => {
    // Never notify the person who caused it.
    if (userId === row.actorId) return;
    if (told.has(userId)) return;
    told.add(userId);
    planned.push({ userId, kind, title, excerpt });
  };

  for (const userId of asIdList(fields.mentionedUserIds)) {
    add(
      userId,
      'chat.mention',
      channelName === null ? 'You were mentioned' : `Mentioned in #${channelName}`,
    );
  }

  if (typeof fields.parentAuthorId === 'string') {
    add(fields.parentAuthorId, 'chat.thread_reply', 'New reply to your message');
  }

  for (const userId of asIdList(fields.directRecipientIds)) {
    add(userId, 'chat.direct', 'New direct message');
  }

  return planned;
}

function asIdList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Moves one batch of chat events into notifications.
 *
 * Runs as `taskflow_audit` for the same reason the audit projection does: it
 * writes on behalf of the system rather than of a request, so it has no
 * `app.org_id` to scope by and writes the org named on each row it projects.
 * Migration 0022 grants that role exactly this table and nothing else.
 */
export async function drainNotifications(limit = 100): Promise<NotificationDrainResult> {
  return withAuditScope(async (tx) => {
    const pending = await claimPending(tx, NOTIFICATION_CONSUMER, limit);
    if (pending.length === 0) return { processed: 0, written: 0 };

    let written = 0;

    for (const row of pending) {
      for (const plan of planNotifications(row)) {
        const inserted = await tx
          .insert(schema.notifications)
          .values({
            id: newId<'NotificationId'>(),
            orgId: row.orgId,
            userId: plan.userId,
            kind: plan.kind,
            subjectType: 'message',
            subjectId: subjectIdOf(row) ?? row.id,
            title: plan.title,
            excerpt: plan.excerpt,
            actorId: row.actorId,
          })
          /* The idempotency this consumer's at-least-once delivery needs. A
             redelivered batch conflicts and is ignored rather than ringing a
             bell twice. */
          .onConflictDoNothing()
          .returning({ id: schema.notifications.id });

        written += inserted.length;
      }
    }

    await markDispatched(
      tx,
      NOTIFICATION_CONSUMER,
      pending.map((row) => row.id),
    );

    return { processed: pending.length, written };
  });
}

/** The message a notification points at. Falls back to the event id. */
function subjectIdOf(row: OutboxRow): string | null {
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return null;

  const messageId = (payload as { readonly messageId?: unknown }).messageId;
  return typeof messageId === 'string' ? messageId : null;
}

/** Drains until the backlog is empty, bounded so a tick always returns. */
export async function drainNotificationsFully(
  batchSize = 100,
  maxBatches = 50,
): Promise<NotificationDrainResult> {
  let processed = 0;
  let written = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainNotifications(batchSize);
    processed += result.processed;
    written += result.written;
    if (result.processed < batchSize) break;
  }

  return { processed, written };
}

/**
 * Marks a person's notifications read. Their own only — the caller supplies a
 * verified user id, and there is no route shape that lets one be named.
 */
export async function markNotificationsRead(
  tx: Parameters<Parameters<typeof withAuditScope>[0]>[0],
  input: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await tx
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(schema.notifications.orgId, input.orgId),
        eq(schema.notifications.userId, input.userId),
      ),
    );
}
