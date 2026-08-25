import {
  and,
  eq,
  insertAuditEntry,
  schema,
  withAuditScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { operatorBroadcastSent } from './events.js';
import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';
import { resolveAudience, type AudienceSpec } from './broadcast-audience.service.js';

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
 * The existing drains (`deliverPendingPushes`, the mail relay) do not care
 * who created a row, only that one exists, so no new delivery code is
 * needed — only a new writer.
 *
 * This also means an operator broadcast does NOT get `apps/realtime`'s
 * instant live-tab delivery — see `events.ts`'s `operatorBroadcastSent` for
 * why, and why that gap is accepted rather than routed around.
 */

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
  events: EventBus,
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
        excerpt: body.length > 300 ? `${body.slice(0, 297)}...` : body,
        actorId: operator.userId,
        createdAt: now,
      });

      const deliveries: { channel: 'push' | 'email' }[] = [];
      if (input.sendPush) deliveries.push({ channel: 'push' });
      if (input.sendEmail) deliveries.push({ channel: 'email' });

      for (const delivery of deliveries) {
        await tx.insert(schema.notificationDeliveries).values({
          id: newId<'NotificationDeliveryId'>(),
          orgId: input.audience.orgId,
          userId: member.userId,
          notificationId,
          channel: delivery.channel,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  });

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

  await events.publish([
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
      .orderBy(schema.operatorBroadcasts.createdAt)
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
