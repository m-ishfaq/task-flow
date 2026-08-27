import {
  and,
  desc,
  eq,
  insertAuditEntry,
  schema,
  withAuditScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { notificationPath } from '../platform/notification-paths.js';
import { markEmailDeliveries, type PendingEmailSend } from '../platform/notification.projection.js';
import { operatorBroadcastSent } from './events.js';
import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';
import {
  resolveAudience,
  type AudienceSpec,
  type AudienceTarget,
  type MembershipRole,
} from './broadcast-audience.service.js';

/**
 * Operator broadcasts — a platform operator messaging a specific member, a
 * role-filtered subset, or every active member of one org (migration 0083).
 *
 * ## Direct writes, not the notification projection
 *
 * `taskflow_platform_admin` holds no grant on `platform.outbox` (§ every
 * other service in this directory documents the same fact), so this cannot
 * emit an event for `notification.projection.ts`'s `planNotifications` to
 * pick up. Instead it writes `platform.notifications` and
 * `platform.notification_deliveries` DIRECTLY — the identical tables the
 * projection writes, via the SAME grant shape 0022 already gave
 * `taskflow_audit` for the identical reason (see migration 0083's header).
 *
 * Bypassing the projection is also why the two channels are NOT symmetric
 * below. `deliverPendingPushes` (`notification-push.ts`) is a genuine
 * poll-and-send DRAIN — it reads `channel='push', status='pending'` off a
 * timer with no idea who wrote the row, so a push delivery written here
 * gets picked up for free. Email has no equivalent drain: the projection's
 * own header explains that `direct`-category email is composed and handed
 * to the mail queue INLINE, at write time, by `notification.projection.ts`
 * itself — a `pending` email row nobody's projection code ever revisits
 * just sits there forever. So this calls `sendNotificationEmail` itself,
 * the same callback `tenancy/relay.ts` hands the projection's own decided
 * sends, and marks the rows `sent` with the same `markEmailDeliveries` the
 * relay uses — reusing the exact mechanism rather than inventing a second
 * one for one more writer.
 *
 * This also means an operator broadcast does NOT get `apps/realtime`'s
 * instant live-tab delivery — see `events.ts`'s `operatorBroadcastSent` for
 * why, and why that gap is accepted rather than routed around.
 */

export interface BroadcastDeps {
  readonly events: EventBus;
  /**
   * Optional, matching `tenancy/relay.ts`'s own `sendNotificationEmail?` —
   * a deployment with no mailer configured leaves email deliveries `pending`
   * rather than throwing, the same honest "not yet sent" state every other
   * unconfigured-channel path in this codebase already reports.
   */
  readonly sendNotificationEmail?: (send: PendingEmailSend) => void;
}

export interface SendBroadcastInput {
  readonly audience: AudienceSpec;
  readonly subject: string;
  readonly body: string;
  readonly sendPush: boolean;
  readonly sendEmail: boolean;
  readonly includeInOrgAudit: boolean;
}

export interface SendBroadcastResult {
  readonly broadcastId: string;
  readonly recipientCount: number;
}

export async function sendBroadcast(
  deps: BroadcastDeps,
  operator: PlatformOperator,
  input: SendBroadcastInput,
): Promise<SendBroadcastResult> {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (subject.length === 0 || subject.length > 120) {
    throw errors.validation({ field: 'subject' }, 'Subject must be 1-120 characters.');
  }
  if (body.length === 0 || body.length > 2000) {
    throw errors.validation({ field: 'body' }, 'Body must be 1-2000 characters.');
  }
  if (!input.sendPush && !input.sendEmail) {
    /* In-app is never optional (this file's own header), but a send with
       BOTH push and email off would still be silent to anyone not already
       looking at the bell — worth refusing rather than surprising the
       operator with a "sent" confirmation nobody outside the app noticed. */
    throw errors.validation(
      { field: 'channels' },
      'At least one of push or email must be enabled.',
    );
  }

  /* Resolved OUTSIDE withPlatformAdminScope's own transaction on purpose —
     resolveAudience opens its own. The recipient list is read once here and
     reused for every insert below; a membership change landing between this
     read and the writes is the same race the dry-run preview already
     accepts (§ design: the count an operator confirms is a snapshot, not a
     live guarantee — re-running the send is how a stale count gets fixed). */
  const members = await resolveAudience(input.audience);

  const now = new Date();
  const broadcastId = newId<'OperatorBroadcastId'>();
  const excerpt = body.length > 300 ? `${body.slice(0, 297)}...` : body;

  /* `notificationPath`'s `operator_broadcast` case is a fixed literal, never
     null — but the fallback stays honest rather than trusting that forever:
     a null path is exactly what makes `notification-push.ts` mark a push
     row `failed` on sight, so a future change to that switch must not
     silently reintroduce the bug this comment is about. */
  const path =
    notificationPath({
      subjectType: 'operator_broadcast',
      subjectId: broadcastId,
      channelId: null,
      boardId: null,
    }) ?? '/home';

  /* Delivery ids for email are minted BEFORE the transaction, one per
     member, so the SAME id is both the row `sendNotificationEmail` gets
     told about below and the row `markEmailDeliveries` marks `sent` — email
     is sent OUTSIDE this transaction (a DB transaction must not hold a
     network call open, the same discipline notification.projection.ts's own
     header states), so nothing here can hand the mailer an id it has not
     committed yet. */
  const emailSends: PendingEmailSend[] = [];
  const emailDeliveryIdByUserId = new Map<string, string>();
  if (input.sendEmail) {
    for (const member of members) {
      const deliveryId = newId<'NotificationDeliveryId'>();
      emailDeliveryIdByUserId.set(member.userId, deliveryId);
      emailSends.push({ deliveryId, to: member.email, title: subject, excerpt, path });
    }
  }

  await withPlatformAdminScope(async (tx) => {
    await tx.insert(schema.operatorBroadcasts).values({
      id: broadcastId,
      operatorId: operator.userId,
      orgId: input.audience.orgId,
      audienceTarget: input.audience.target,
      audienceRole: input.audience.membershipRole ?? null,
      audienceUserIds: input.audience.userIds !== undefined ? [...input.audience.userIds] : null,
      subject,
      body,
      sendPush: input.sendPush,
      sendEmail: input.sendEmail,
      includedInOrgAudit: input.includeInOrgAudit,
      recipientCount: members.length,
      createdAt: now,
    });

    for (const member of members) {
      const notificationId = newId<'NotificationId'>();
      await tx.insert(schema.notifications).values({
        id: notificationId,
        orgId: input.audience.orgId,
        userId: member.userId,
        kind: 'operator_broadcast',
        subjectType: 'operator_broadcast',
        subjectId: broadcastId,
        title: subject,
        excerpt,
        /* Not `operator.userId`. An operator is structurally never
           guaranteed to be a member of the org they are broadcasting to
           (Phase 12 Wave 1 — operator status and org membership are
           independent), so every client that resolves an actor id against
           the ORG's own roster (`use-members.ts`'s `personOf`, ported
           identically to `apps/web`) finds nothing and falls back to
           printing the raw uuid — a real id leaking as visible, confusing
           text in the notification list on both platforms. A broadcast is
           institutional, not from a person the recipient has ever heard
           of; no actor is the honest shape, the same as an announcement
           from a scheduled sweep rather than a coworker's action. */
        actorId: null,
        createdAt: now,
      });

      if (input.sendPush) {
        await tx.insert(schema.notificationDeliveries).values({
          id: newId<'NotificationDeliveryId'>(),
          orgId: input.audience.orgId,
          userId: member.userId,
          notificationId,
          channel: 'push',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
      }

      if (input.sendEmail) {
        const deliveryId = emailDeliveryIdByUserId.get(member.userId);
        if (deliveryId === undefined) {
          // Cannot happen — emailSends is built 1:1 from the same `members`
          // array — but a silent skip here would be a lost email with no
          // signal, so this fails loudly instead.
          throw new Error(`No email delivery id minted for member ${member.userId}.`);
        }
        await tx.insert(schema.notificationDeliveries).values({
          id: deliveryId,
          orgId: input.audience.orgId,
          userId: member.userId,
          notificationId,
          channel: 'email',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  });

  /* Push needs nothing further — `deliverPendingPushes` is a genuine
     poll-and-send drain over `channel='push', status='pending'` with no
     idea who wrote the row (this file's own header). Email has no such
     drain, so it is sent HERE, after the transaction committed, exactly
     the way `tenancy/relay.ts` sends the projection's own decided emails —
     reusing that callback and `markEmailDeliveries` rather than a second
     delivery mechanism. */
  if (emailSends.length > 0 && deps.sendNotificationEmail !== undefined) {
    for (const send of emailSends) {
      deps.sendNotificationEmail(send);
    }
    await markEmailDeliveries(
      emailSends.map((send) => send.deliveryId),
      'sent',
    );
  }

  /* The org's own audit trail — optional per send (§ design: an internal or
     test broadcast should not have to appear in a tenant's own history),
     unlike the global operator log below, which is never optional. */
  if (input.includeInOrgAudit) {
    await withAuditScope(async (tx) => {
      await insertAuditEntry(tx, {
        id: newId<'EventId'>(),
        orgId: input.audience.orgId,
        occurredAt: now,
        actorId: operator.userId,
        action: 'platform.operator_broadcast_sent',
        resourceType: 'operator_broadcast',
        resourceId: broadcastId,
        changes: {
          audienceTarget: input.audience.target,
          audienceRole: input.audience.membershipRole ?? null,
          recipientCount: members.length,
          subject,
        },
        requestId: operator.requestId,
      });
    });
  }

  await recordOperatorAction(operator.userId, 'broadcast.send', {
    orgId: input.audience.orgId,
    audienceTarget: input.audience.target,
    recipientCount: members.length,
  });

  await deps.events.publish([
    createEvent(
      operatorBroadcastSent,
      {
        broadcastId,
        orgId: input.audience.orgId,
        audienceTarget: input.audience.target,
        recipientCount: members.length,
        operatorUserId: operator.userId,
      },
      {
        orgId: input.audience.orgId,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return { broadcastId, recipientCount: members.length };
}

export interface BroadcastHistoryRow {
  readonly id: string;
  readonly subject: string;
  readonly audienceTarget: 'all' | 'role' | 'users';
  readonly recipientCount: number;
  readonly createdAt: Date;
}

/**
 * The org's own broadcast history — ONLY the sends `includeInOrgAudit`
 * marked visible to it (§ design decision: not every send should appear in
 * a tenant's own history), which is why this filters on
 * `includedInOrgAudit`, not merely `orgId`.
 */
export async function getBroadcastHistory(
  orgId: OrgId,
  limit: number,
): Promise<readonly BroadcastHistoryRow[]> {
  const rows = await withPlatformAdminScope(async (tx) =>
    tx
      .select({
        id: schema.operatorBroadcasts.id,
        subject: schema.operatorBroadcasts.subject,
        audienceTarget: schema.operatorBroadcasts.audienceTarget,
        recipientCount: schema.operatorBroadcasts.recipientCount,
        createdAt: schema.operatorBroadcasts.createdAt,
      })
      .from(schema.operatorBroadcasts)
      .where(
        and(
          eq(schema.operatorBroadcasts.orgId, orgId),
          eq(schema.operatorBroadcasts.includedInOrgAudit, true),
        ),
      )
      /* NEWEST first — a history view read with a `limit` wants the most
         recent sends, not the oldest. The default ascending order combined
         with `.limit()` returned the FIRST N ever sent and hid recent ones,
         the exact opposite of what the org index (created_at DESC) is shaped
         for. `id` (a time-ordered UUIDv7) is a deterministic tiebreaker so
         two sends in the same instant still order stably. */
      .orderBy(desc(schema.operatorBroadcasts.createdAt), desc(schema.operatorBroadcasts.id))
      .limit(limit),
  );

  /* `audienceTarget` is `text` at the Drizzle layer (the migration's CHECK
     constraint is what actually closes it to these three values, the same
     "CHECK, not an enum" choice every other kind column in this schema
     makes) — narrowed here, once, rather than trusting the cast at every
     call site. */
  return rows.map((row) => ({
    ...row,
    audienceTarget: row.audienceTarget as 'all' | 'role' | 'users',
  }));
}

/**
 * Re-runs a past send with its EXACT original parameters — subject, body,
 * audience, channels, and the org-audit-visibility choice — read back off
 * its own tracking row rather than accepted from the caller, so a resend
 * can never silently drift from what it claims to repeat.
 *
 * A resend is a brand-new `sendBroadcast` call, not a retry of the old
 * delivery rows: it gets its own broadcast id, its own tracking row, and a
 * FRESH audience resolution. That last part is deliberate, not an
 * oversight — membership can change between the original send and a
 * resend, and repeating "whoever was active then" would either miss a
 * person who joined since or message one who has since left, neither of
 * which is what "send this again" means.
 */
export async function resendBroadcast(
  deps: BroadcastDeps,
  operator: PlatformOperator,
  broadcastId: string,
): Promise<SendBroadcastResult> {
  const rows = await withPlatformAdminScope(async (tx) =>
    tx
      .select({
        orgId: schema.operatorBroadcasts.orgId,
        audienceTarget: schema.operatorBroadcasts.audienceTarget,
        audienceRole: schema.operatorBroadcasts.audienceRole,
        audienceUserIds: schema.operatorBroadcasts.audienceUserIds,
        subject: schema.operatorBroadcasts.subject,
        body: schema.operatorBroadcasts.body,
        sendPush: schema.operatorBroadcasts.sendPush,
        sendEmail: schema.operatorBroadcasts.sendEmail,
        includedInOrgAudit: schema.operatorBroadcasts.includedInOrgAudit,
      })
      .from(schema.operatorBroadcasts)
      .where(eq(schema.operatorBroadcasts.id, broadcastId))
      .limit(1),
  );

  const row = rows[0];
  if (!row) throw errors.notFound('That broadcast no longer exists.');

  const target = row.audienceTarget as AudienceTarget;
  const audience: AudienceSpec = {
    orgId: row.orgId as OrgId,
    target,
    ...(row.audienceRole !== null ? { membershipRole: row.audienceRole as MembershipRole } : {}),
    ...(row.audienceUserIds !== null
      ? { userIds: row.audienceUserIds.map((id) => id as UserId) }
      : {}),
  };

  return sendBroadcast(deps, operator, {
    audience,
    subject: row.subject,
    body: row.body,
    sendPush: row.sendPush,
    sendEmail: row.sendEmail,
    includeInOrgAudit: row.includedInOrgAudit,
  });
}
