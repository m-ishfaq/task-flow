import {
  and,
  claimPending,
  eq,
  inArray,
  isNull,
  markDispatched,
  schema,
  withAuditScope,
  type OutboxRow,
} from '@taskflow/db';
import { newId } from '@taskflow/security';
import { categoryOfKind, resolvePref, type ExplicitPref } from './notification-prefs.js';

/**
 * Turning domain events into notifications (PLAN.md §10.6; Phase 5
 * ai/phase-5-chat.md §4; Phase 9 ai/phase-9-notifications.md §3.1, §4).
 *
 * ## No longer chat-only, and moved out of `chat/` because of it
 *
 * This started as chat's own projection, consuming only `message.sent`. Phase
 * 9 is 0022's own header being made true — "Phase 9 is expected to ADD to
 * this table rather than replace it" — by adding Work (`card.assigned`,
 * `comment.created` mentions) and Docs (`page.comment_created` mentions) as
 * producers of the same `platform.notifications` rows. Living under `chat/`
 * stopped being honest the moment it read an event `chat/` does not own, so
 * it moved to `platform/`, alongside the schema it writes.
 *
 * ## A third (now fifth) consumer, not a second mechanism
 *
 * Migration 0015 gave the outbox a claim per CONSUMER (`outbox_dispatch`), so
 * `audit` and `realtime` already drain the same rows independently and
 * neither starves the other. This is still the `'notifications'` name —
 * adding new EVENT NAMES this consumer reads is not adding a new consumer.
 *
 * ## At-least-once, and made idempotent by a unique index
 *
 * Unlike the audit projection, this one does NOT get exactly-once: it claims,
 * writes, and marks in one transaction, but a crash between the write and the
 * mark redelivers the batch. `notifications_event_user_key` is what makes
 * that harmless — a redelivered event conflicts on (org, subject, user, kind)
 * and is ignored rather than ringing somebody's bell twice. Migration 0027's
 * `notification_deliveries_once` gives the delivery-tracking row the
 * identical guarantee.
 *
 * ## Nobody is notified about their own action
 *
 * The most common bug in this shape, and the one that makes a notification
 * system feel broken rather than wrong: you assign a card to yourself, or
 * @mention a colleague while replying inside your own thread, and you get the
 * notification too because you caused the event. Every `plan*` function below
 * excludes `row.actorId`.
 *
 * ## The excerpt is a SNAPSHOT, deliberately
 *
 * `title` and `excerpt` are written here and never re-read from the message,
 * card, or page. Two reasons, and the second is the one that matters: a
 * notification must survive its subject being deleted or archived, and
 * rendering a list of fifty notifications must not re-read fifty channels or
 * boards the reader may have since been removed from. What is stored is what
 * they were entitled to see at the moment they were told.
 *
 * ## Email is decided here and SENT after the transaction commits
 *
 * The transaction below decides who gets emailed (consulting
 * `notification_prefs`) and writes a `notification_deliveries` row per
 * eligible recipient — but it does not call SMTP from inside a database
 * transaction, for the identical reason `identity/deliver.ts` never awaits
 * mail from inside a request handler. `drainNotifications` RETURNS the list
 * of emails to send; the caller (here, `drainNotificationsFully`) sends them
 * after the transaction is done and marks them `sent` in a follow-up
 * transaction. "Sent" in Wave 1 means "handed to `packages/mail`'s queue",
 * not "delivered" — the queue's own retry/abandon handles the rest, the same
 * honest simplification `identity/deliver.ts` already accepts.
 */

/** The consumer name this projection claims under. Unchanged since 0015/0022. */
export const NOTIFICATION_CONSUMER = 'notifications';

export interface NotificationDrainResult {
  readonly processed: number;
  readonly written: number;
  /** Emails this batch decided to send. The caller sends them; see the file header. */
  readonly pendingEmails: readonly PendingEmailSend[];
}

export interface PendingEmailSend {
  readonly deliveryId: string;
  readonly to: string;
  readonly title: string;
  readonly excerpt: string | null;
  /** An absolute in-app path — see `notificationPath` below. */
  readonly path: string;
}

type NotificationKind =
  | 'chat.mention'
  | 'chat.direct'
  | 'chat.thread_reply'
  | 'card.assigned'
  | 'card.comment_mention'
  | 'page.comment_mention';

interface PlannedNotification {
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly subjectType: 'message' | 'card' | 'page';
  readonly subjectId: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly channelId: string | null;
  readonly boardId: string | null;
}

/**
 * What one event should tell whom.
 *
 * Pure, and separated from the write so it can be tested without a database —
 * "who gets told about this" is the whole logic, and it is worth being able
 * to assert directly.
 */
export function planNotifications(row: OutboxRow): readonly PlannedNotification[] {
  switch (row.name) {
    case 'message.sent':
      return planMessageSent(row);
    case 'card.assigned':
      return planCardAssigned(row);
    case 'comment.created':
      return planCardCommentMention(row);
    case 'page.comment_created':
      return planPageCommentMention(row);
    default:
      return [];
  }
}

function planMessageSent(row: OutboxRow): readonly PlannedNotification[] {
  const record = asRecord(row.payload);
  if (record === null) return [];
  const fields = record as {
    readonly excerpt?: unknown;
    readonly channelName?: unknown;
    readonly channelId?: unknown;
    readonly messageId?: unknown;
    readonly mentionedUserIds?: unknown;
    readonly parentAuthorId?: unknown;
    readonly directRecipientIds?: unknown;
  };

  const excerpt = typeof fields.excerpt === 'string' ? fields.excerpt : null;
  const channelName = typeof fields.channelName === 'string' ? fields.channelName : null;
  const channelId = typeof fields.channelId === 'string' ? fields.channelId : null;
  const subjectId = typeof fields.messageId === 'string' ? fields.messageId : row.id;

  /* Deduplicated ACROSS kinds, not just within one. Somebody mentioned in a
     reply to their own message in a DM would otherwise get three rows for one
     message — and the unique index would reject two of them, turning a
     cosmetic problem into a failed batch. First kind wins, in priority order:
     a mention is more specific than a thread reply, which is more specific
     than "a message arrived". */
  const told = new Set<string>();
  const planned: PlannedNotification[] = [];

  const add = (userId: string, kind: NotificationKind, title: string): void => {
    if (userId === row.actorId) return;
    if (told.has(userId)) return;
    told.add(userId);
    planned.push({
      userId,
      kind,
      subjectType: 'message',
      subjectId,
      title,
      excerpt,
      channelId,
      boardId: null,
    });
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

/** `card.assigned` carries `before`/`after` in full — "newly assigned" is `after` minus `before`. */
function planCardAssigned(row: OutboxRow): readonly PlannedNotification[] {
  const record = asRecord(row.payload);
  if (record === null) return [];
  const fields = record as {
    readonly cardId?: unknown;
    readonly boardId?: unknown;
    readonly before?: unknown;
    readonly after?: unknown;
  };

  const cardId = typeof fields.cardId === 'string' ? fields.cardId : null;
  const boardId = typeof fields.boardId === 'string' ? fields.boardId : null;
  if (cardId === null || boardId === null) return [];

  const before = new Set(asIdList(fields.before));
  const newlyAssigned = asIdList(fields.after).filter((userId) => !before.has(userId));

  const planned: PlannedNotification[] = [];
  const told = new Set<string>();
  for (const userId of newlyAssigned) {
    // Self-assignment is not a notification about yourself.
    if (userId === row.actorId) continue;
    if (told.has(userId)) continue;
    told.add(userId);
    planned.push({
      userId,
      kind: 'card.assigned',
      subjectType: 'card',
      subjectId: cardId,
      title: 'You were assigned a card',
      excerpt: null,
      channelId: null,
      boardId,
    });
  }
  return planned;
}

/** Work's `comment.created` — a card comment `@mention`. */
function planCardCommentMention(row: OutboxRow): readonly PlannedNotification[] {
  const record = asRecord(row.payload);
  if (record === null) return [];
  const fields = record as {
    readonly cardId?: unknown;
    readonly boardId?: unknown;
    readonly excerpt?: unknown;
    readonly mentionedUserIds?: unknown;
  };

  const cardId = typeof fields.cardId === 'string' ? fields.cardId : null;
  const boardId = typeof fields.boardId === 'string' ? fields.boardId : null;
  if (cardId === null || boardId === null) return [];

  const excerpt = typeof fields.excerpt === 'string' ? fields.excerpt : null;

  const planned: PlannedNotification[] = [];
  const told = new Set<string>();
  for (const userId of asIdList(fields.mentionedUserIds)) {
    if (userId === row.actorId) continue;
    if (told.has(userId)) continue;
    told.add(userId);
    planned.push({
      userId,
      kind: 'card.comment_mention',
      subjectType: 'card',
      subjectId: cardId,
      title: 'You were mentioned in a comment',
      excerpt,
      channelId: null,
      boardId,
    });
  }
  return planned;
}

/** Docs' `page.comment_created` — a page comment `@mention`. */
function planPageCommentMention(row: OutboxRow): readonly PlannedNotification[] {
  const record = asRecord(row.payload);
  if (record === null) return [];
  const fields = record as {
    readonly pageId?: unknown;
    readonly excerpt?: unknown;
    readonly mentionedUserIds?: unknown;
  };

  const pageId = typeof fields.pageId === 'string' ? fields.pageId : null;
  if (pageId === null) return [];

  const excerpt = typeof fields.excerpt === 'string' ? fields.excerpt : null;

  const planned: PlannedNotification[] = [];
  const told = new Set<string>();
  for (const userId of asIdList(fields.mentionedUserIds)) {
    if (userId === row.actorId) continue;
    if (told.has(userId)) continue;
    told.add(userId);
    planned.push({
      userId,
      kind: 'page.comment_mention',
      subjectType: 'page',
      subjectId: pageId,
      title: 'You were mentioned in a comment',
      excerpt,
      channelId: null,
      boardId: null,
    });
  }
  return planned;
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function asIdList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Where clicking a notification navigates — see `apps/web/src/router.tsx`.
 * `null` for a shape this build does not know how to link (never happens for
 * a `subjectType` this file itself produces, but the return type keeps a
 * caller honest about the case).
 */
function notificationPath(plan: PlannedNotification): string | null {
  switch (plan.subjectType) {
    case 'message':
      return plan.channelId === null ? null : `/chat?channel=${plan.channelId}`;
    case 'card':
      return plan.boardId === null ? null : `/boards/${plan.boardId}?card=${plan.subjectId}`;
    case 'page':
      return `/docs?page=${plan.subjectId}`;
  }
}

/**
 * Moves one batch of domain events into notifications, and decides (but does
 * not send) email.
 *
 * Runs as `taskflow_audit` for the same reason the audit projection does: it
 * writes on behalf of the system rather than of a request, so it has no
 * `app.org_id` to scope by and writes the org named on each row it projects.
 * Migration 0027 additionally grants it SELECT on `notification_prefs` and a
 * narrow column set of `identity.users` — see that migration's header for
 * why the column list is deliberately short.
 */
export async function drainNotifications(limit = 100): Promise<NotificationDrainResult> {
  return withAuditScope(async (tx) => {
    const pending = await claimPending(tx, NOTIFICATION_CONSUMER, limit);
    if (pending.length === 0) return { processed: 0, written: 0, pendingEmails: [] };

    let written = 0;
    /* Recipients whose preferences and idempotent delivery insert both said
       "email this person", keyed by userId — resolved to addresses and turned
       into `PendingEmailSend`s in one batched query after the loop, rather
       than per-recipient, and never keyed by anything two different people
       could share (a path, a title) the way an earlier version of this
       function briefly was. */
    const emailCandidates: {
      readonly userId: string;
      readonly deliveryId: string;
      readonly title: string;
      readonly excerpt: string | null;
      readonly path: string;
    }[] = [];

    for (const row of pending) {
      const plans = planNotifications(row);
      if (plans.length === 0) continue;

      // One preference read per recipient per row — this runs on a background
      // timer over batches of at most a few hundred rows, not a request path,
      // so the N+1 here is a deliberate simplicity/latency tradeoff rather
      // than an oversight.
      const recipientIds = [...new Set(plans.map((plan) => plan.userId))];
      const prefRows = await tx
        .select({
          category: schema.notificationPrefs.category,
          channel: schema.notificationPrefs.channel,
          enabled: schema.notificationPrefs.enabled,
          userId: schema.notificationPrefs.userId,
        })
        .from(schema.notificationPrefs)
        // Global per user, not per org (identity.notification_prefs — see
        // migration 0027's header) — no orgId in this WHERE, unlike every
        // other query in this file.
        .where(inArray(schema.notificationPrefs.userId, recipientIds));

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

      for (const plan of plans) {
        const inserted = await tx
          .insert(schema.notifications)
          .values({
            id: newId<'NotificationId'>(),
            orgId: row.orgId,
            userId: plan.userId,
            kind: plan.kind,
            subjectType: plan.subjectType,
            subjectId: plan.subjectId,
            channelId: plan.channelId,
            boardId: plan.boardId,
            title: plan.title,
            excerpt: plan.excerpt,
            actorId: row.actorId,
          })
          /* The idempotency this consumer's at-least-once delivery needs. A
             redelivered batch conflicts and is ignored rather than ringing a
             bell twice. */
          .onConflictDoNothing()
          .returning({ id: schema.notifications.id });

        const notificationId = inserted[0]?.id;
        if (notificationId === undefined) continue; // Already delivered — a redelivery.
        written += 1;

        const category = categoryOfKind(plan.kind);
        const wantsEmail = resolvePref(prefsByUser.get(plan.userId) ?? [], category, 'email');
        if (!wantsEmail) continue;

        const path = notificationPath(plan);
        if (path === null) continue;

        const deliveryId = newId<'NotificationDeliveryId'>();
        const deliveryInserted = await tx
          .insert(schema.notificationDeliveries)
          .values({
            id: deliveryId,
            orgId: row.orgId,
            userId: plan.userId,
            notificationId,
            channel: 'email',
            status: 'pending',
          })
          .onConflictDoNothing()
          .returning({ id: schema.notificationDeliveries.id });

        if (deliveryInserted.length === 0) continue; // Already queued — a redelivery.

        emailCandidates.push({
          userId: plan.userId,
          deliveryId,
          title: plan.title,
          excerpt: plan.excerpt,
          path,
        });
      }
    }

    await markDispatched(
      tx,
      NOTIFICATION_CONSUMER,
      pending.map((row) => row.id),
    );

    const pendingEmails =
      emailCandidates.length === 0 ? [] : await resolveEmailAddresses(tx, emailCandidates);

    return { processed: pending.length, written, pendingEmails };
  });
}

/**
 * Resolves each candidate's address in one batched query and drops any
 * candidate whose user has no address (should not happen — every account has
 * one — but a projection must not crash a batch over a row it cannot fully
 * resolve).
 */
async function resolveEmailAddresses(
  tx: Parameters<Parameters<typeof withAuditScope>[0]>[0],
  candidates: readonly {
    readonly userId: string;
    readonly deliveryId: string;
    readonly title: string;
    readonly excerpt: string | null;
    readonly path: string;
  }[],
): Promise<readonly PendingEmailSend[]> {
  const userIds = [...new Set(candidates.map((candidate) => candidate.userId))];
  const addresses = await tx
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.id, userIds));

  const addressByUserId = new Map(addresses.map((user) => [user.id, user.email]));

  const sends: PendingEmailSend[] = [];
  for (const candidate of candidates) {
    const to = addressByUserId.get(candidate.userId);
    if (to === undefined) continue;
    sends.push({
      deliveryId: candidate.deliveryId,
      to,
      title: candidate.title,
      excerpt: candidate.excerpt,
      path: candidate.path,
    });
  }
  return sends;
}

/** Drains until the backlog is empty, bounded so a tick always returns. */
export async function drainNotificationsFully(
  batchSize = 100,
  maxBatches = 50,
): Promise<NotificationDrainResult> {
  let processed = 0;
  let written = 0;
  const pendingEmails: PendingEmailSend[] = [];

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainNotifications(batchSize);
    processed += result.processed;
    written += result.written;
    pendingEmails.push(...result.pendingEmails);
    if (result.processed < batchSize) break;
  }

  return { processed, written, pendingEmails };
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

/**
 * Marks a batch of email deliveries `sent` (Wave 1 meaning: handed to
 * `packages/mail`'s queue — see the file header) or `suppressed`. Runs as its
 * own `withAuditScope` transaction, after the sends themselves — never
 * inside the transaction that decided them, for the same non-blocking reason
 * `identity/deliver.ts` never awaits mail from inside a request.
 */
export async function markEmailDeliveries(
  deliveryIds: readonly string[],
  status: 'sent' | 'suppressed',
  reason?: string,
): Promise<void> {
  if (deliveryIds.length === 0) return;
  await withAuditScope(async (tx) => {
    await tx
      .update(schema.notificationDeliveries)
      .set({ status, reason: reason ?? null, updatedAt: new Date() })
      .where(
        and(
          inArray(schema.notificationDeliveries.id, [...deliveryIds]),
          isNull(schema.notificationDeliveries.reason),
        ),
      );
  });
}
