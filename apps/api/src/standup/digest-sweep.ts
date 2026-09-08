import { and, eq, schema, withAuditScope, withOrgScope } from '@taskflow/db';
import { unsafeAsId, type OrgId, type ProjectId, type UserId } from '@taskflow/contracts';
import type { Logger } from '@taskflow/observability';
import { newId } from '@taskflow/security';
import { resolveOrgMembership } from '../tenancy/resolve.js';
import type { WorkActor } from '../work/shared.js';
import { queryStandup } from './standup.service.js';
import { sendStandupDigest, type StandupMailDeps } from './standup-mail.js';

/**
 * Drives the standup-subscription digest on a daily timer — the same
 * accepted timer-in-the-API placeholder `platform/digest.ts` and
 * `tenancy/relay.ts` both already document. See migration 0108's own header
 * and `subscription.service.ts` for what a subscription actually is.
 *
 * ## Why this is NOT built on `platform/digest.ts`'s own machinery
 *
 * That sweep batches DELIVERY of rows already written by the notification
 * projection — one row per event, marked `sent` once mailed. A standup
 * subscription describes no event at all; it is a standing preference
 * ("email me project X's standup every day"), and what gets sent each day
 * is computed FRESH from `queryStandup`, never accumulated. There is
 * nothing here to mark `sent` — the subscription row itself never changes
 * on a successful send, the same way an alarm clock is not "consumed" by
 * going off.
 *
 * ## Cross-org read, then per-org authorization — the same split
 * `platform/digest.ts` uses
 *
 * `collectStandupSubscriptions` runs as `taskflow_audit` (migration 0108's
 * own grant, mirroring 0027's identical shape for `notification_deliveries`)
 * to see every org's subscriptions in one pass. Everything after that —
 * `resolveOrgMembership`, `queryStandup` — runs as the ordinary
 * `taskflow_app` role inside that ONE subscription's own org scope. Nothing
 * here uses `withGlobalScope`; the cross-org read is the audit role's job,
 * exactly as designed.
 *
 * ## A stale or now-unauthorized subscription is skipped, never a sweep
 * failure
 *
 * `resolveOrgMembership` re-resolves the subscriber's CURRENT role and
 * membership every run — the identical "a demotion takes effect
 * immediately" property `apps/worker`'s automation executor already relies
 * on for a rule's owner. A member removed from the org, or from the
 * project's own tuple-granted access since subscribing, is silently
 * skipped for that day rather than crashing the whole tick — the same
 * per-item resilience `sprint_add_cards`/`bulkReassignCards` already apply
 * to a batch where one bad item must not sink the rest. The row itself is
 * left alone: this sweep only sends mail, it never deletes a subscription,
 * so a temporary access loss (a tuple edited back) resumes on its own the
 * next day with no re-subscribe needed.
 */

interface PendingSubscription {
  readonly orgId: string;
  readonly projectId: string;
  readonly userId: string;
}

const BATCH = 500;

async function collectStandupSubscriptions(limit = BATCH): Promise<readonly PendingSubscription[]> {
  return withAuditScope(async (tx) => {
    const rows = await tx
      .select({
        orgId: schema.standupSubscriptions.orgId,
        projectId: schema.standupSubscriptions.projectId,
        userId: schema.standupSubscriptions.userId,
      })
      .from(schema.standupSubscriptions)
      /* Phase 12 Wave 1 §3.9's own precedent: a subscription in a suspended
         org rides no digest while it is suspended. */
      .innerJoin(
        schema.orgs,
        and(
          eq(schema.orgs.id, schema.standupSubscriptions.orgId),
          eq(schema.orgs.status, 'active'),
        ),
      )
      .limit(limit);

    return rows;
  });
}

/**
 * Everything one subscription needs beyond `StandupResult` — the recipient's
 * address and the project's name, neither of which `queryStandup` returns.
 * A plain, unauthorizing read: reaching this point already proved the
 * subscriber can read the project (`queryStandup` succeeded), so this is
 * not a second authorization decision, only two more columns.
 */
async function recipientDetailsFor(
  orgId: OrgId,
  projectId: ProjectId,
  userId: UserId,
): Promise<{ readonly email: string; readonly projectName: string } | null> {
  return withOrgScope(orgId, async (tx) => {
    const [userRows, projectRows] = await Promise.all([
      tx
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1),
      tx
        .select({ name: schema.projects.name })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .limit(1),
    ]);

    const email = userRows[0]?.email;
    if (email === undefined) return null;

    return { email, projectName: projectRows[0]?.name ?? 'this project' };
  });
}

async function sendOneDigest(
  mailDeps: StandupMailDeps,
  subscription: PendingSubscription,
  logger: Logger,
): Promise<void> {
  const orgId = unsafeAsId<'OrgId'>(subscription.orgId);
  const projectId = unsafeAsId<'ProjectId'>(subscription.projectId);
  const userId = unsafeAsId<'UserId'>(subscription.userId);

  try {
    const membership = await resolveOrgMembership(userId, subscription.orgId);
    if (membership === null) return; // No longer a member — skip silently, see file header.

    const actor: WorkActor = {
      subject: {
        orgId: membership.orgId,
        userId,
        role: membership.role,
        tuples: membership.tuples,
        memberGrants: membership.memberGrants,
      },
      requestId: newId<'RequestId'>(),
    };

    const standup = await queryStandup(actor, { projectId });

    const details = await recipientDetailsFor(orgId, projectId, userId);
    if (details === null) return;

    sendStandupDigest(mailDeps, {
      to: details.email,
      projectName: details.projectName,
      projectId: subscription.projectId,
      standup,
    });
  } catch (error) {
    // A suspended membership, a deleted project, or any other refusal —
    // logged, never rethrown, so one broken subscription cannot stop the
    // rest of the batch. The identical reasoning `startDigestSweep`'s own
    // tick-level catch already states, applied per item here instead.
    logger.warn(
      { err: error, orgId: subscription.orgId, projectId: subscription.projectId },
      'standup digest skipped one subscription',
    );
  }
}

export interface StandupDigestSweepHandle {
  readonly stop: () => void;
}

export interface StartStandupDigestSweepOptions {
  readonly logger: Logger;
  readonly mail: StandupMailDeps;
  readonly intervalMs?: number;
}

/** One day — the identical cadence `platform/digest.ts`'s own `DAILY_MS` uses. */
const DAILY_MS = 24 * 60 * 60 * 1000;

export function startStandupDigestSweep(
  options: StartStandupDigestSweepOptions,
): StandupDigestSweepHandle {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const subscriptions = await collectStandupSubscriptions();
      for (const subscription of subscriptions) {
        await sendOneDigest(options.mail, subscription, options.logger);
      }
      if (subscriptions.length > 0) {
        options.logger.info({ subscriptions: subscriptions.length }, 'standup digest sweep sent');
      }
    } catch (error) {
      options.logger.error({ err: error }, 'standup digest sweep failed');
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
