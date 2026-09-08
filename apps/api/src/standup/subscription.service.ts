import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { ProjectId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { requireProject } from '../work/project.service.js';
import { orgOf, userOf, envelopeOf, type WorkActor } from '../work/shared.js';
import { standupSubscriptionCreated, standupSubscriptionRemoved } from './events.js';

/**
 * "Email me this project's standup, daily" (migration 0108,
 * ai/phase-15-ai-copilot-and-permissions.md §5's own text naming this as an
 * optional follow-up: "an optional emailed copy can reuse the existing
 * notification-mail path later if wanted, but is not required for this
 * wave"). This is that later.
 *
 * ## Opt-in, per project, per person — never an org-wide default
 *
 * Subscribing is `project:read` — the identical floor `queryStandup` itself
 * uses, deliberately: a subscription can never name a project the
 * subscriber cannot already open, and there is no separate permission for
 * "may receive this project's standup by email" beyond being able to see
 * the standup screen itself. There is no admin control that enrolls someone
 * else — a person subscribes themselves, the same self-referential shape
 * `identity.notification_prefs` already has.
 *
 * ## Idempotent both ways
 *
 * Subscribing twice is a no-op on the ROW (`onConflictDoNothing` against
 * `standup_subscriptions_unique`), the identical "a retried batch should
 * not duplicate" reasoning `memberGrants.grant` already established —
 * still emits its own event every call, since a person clicking the toggle
 * twice is a real attempt worth recording, not a client bug to paper over.
 * Unsubscribing when never subscribed only emits when a row was actually
 * deleted — an event that claims something changed when nothing did would
 * be a false entry in the audit log.
 */

export async function subscribe(
  actor: WorkActor,
  input: { readonly projectId: ProjectId },
): Promise<{ readonly subscribed: true }> {
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:read');

    await tx
      .insert(schema.standupSubscriptions)
      .values({
        id: newId<'StandupSubscriptionId'>(),
        orgId,
        projectId: input.projectId,
        userId: userOf(actor),
      })
      .onConflictDoNothing();

    await outboxWriter.append(tx, [
      createEvent(
        standupSubscriptionCreated,
        { projectId: input.projectId, userId: userOf(actor) },
        envelopeOf(actor),
      ),
    ]);

    return { subscribed: true as const };
  });
}

export async function unsubscribe(
  actor: WorkActor,
  input: { readonly projectId: ProjectId },
): Promise<{ readonly unsubscribed: boolean }> {
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const deleted = await tx
      .delete(schema.standupSubscriptions)
      .where(
        and(
          eq(schema.standupSubscriptions.orgId, orgId),
          eq(schema.standupSubscriptions.projectId, input.projectId),
          eq(schema.standupSubscriptions.userId, userOf(actor)),
        ),
      )
      .returning({ id: schema.standupSubscriptions.id });

    if (deleted.length === 0) return { unsubscribed: false };

    await outboxWriter.append(tx, [
      createEvent(
        standupSubscriptionRemoved,
        { projectId: input.projectId, userId: userOf(actor) },
        envelopeOf(actor),
      ),
    ]);

    return { unsubscribed: true };
  });
}

/**
 * Whether the caller is subscribed — floored on `project:read` too, so this
 * cannot be used to probe a project the caller cannot otherwise see.
 */
export async function isSubscribed(
  actor: WorkActor,
  input: { readonly projectId: ProjectId },
): Promise<{ readonly subscribed: boolean }> {
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:read');

    const rows = await tx
      .select({ id: schema.standupSubscriptions.id })
      .from(schema.standupSubscriptions)
      .where(
        and(
          eq(schema.standupSubscriptions.orgId, orgId),
          eq(schema.standupSubscriptions.projectId, input.projectId),
          eq(schema.standupSubscriptions.userId, userOf(actor)),
        ),
      )
      .limit(1);

    return { subscribed: rows.length > 0 };
  });
}
