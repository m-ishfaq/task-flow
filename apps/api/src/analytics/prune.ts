import { and, eq, inArray, isNull, lte, withOrgScope, schema } from '@taskflow/db';
import type { OrgId } from '@taskflow/contracts';

/**
 * Outbox pruning (Phase 11 Wave 4, ai/phase-11-analytics.md §7 decision 7).
 *
 * §2.4 establishes the ordering constraint: this phase's backfill must run
 * BEFORE any outbox pruning ships, because the outbox is the accidental
 * event store the backfill replays. Once `analytics.card_transitions` is
 * populated, the outbox no longer needs to serve as an event log and can be
 * pruned on a retention window.
 *
 * ## How pruning works
 *
 * Outbox events that have been dispatched to ALL consumers are safe to delete.
 * An event with no remaining undelivered consumers is inert — it can never
 * produce a side effect again.
 *
 * The pruning uses a two-step approach to avoid raw SQL:
 * 1. Find events with ANY pending (undispatched) consumer — these are NOT safe.
 * 2. Find old events NOT in that set — these ARE safe.
 * 3. Delete dispatch rows, then outbox events (children before parents).
 *
 * Runs per-org under `withOrgScope`. The retention window defaults to 30 days.
 */

export interface PruneResult {
  readonly eventsPruned: number;
  readonly dispatchesPruned: number;
}

/**
 * Prunes old outbox events that have been fully dispatched.
 *
 * An event is "fully dispatched" when every consumer has a dispatch row with
 * `dispatched_at IS NOT NULL`. Events with pending consumers are left alone.
 */
export async function pruneOutbox(
  orgId: OrgId,
  retentionDays = 30,
): Promise<PruneResult> {
  return withOrgScope(orgId, async (tx) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    // Step 1: Find event ids that STILL have a pending consumer
    // (dispatched_at IS NULL). These are NOT safe to prune.
    const pendingEvents = await tx
      .selectDistinct({ eventId: schema.outboxDispatch.eventId })
      .from(schema.outboxDispatch)
      .where(isNull(schema.outboxDispatch.dispatchedAt));

    const pendingIds = new Set(pendingEvents.map((e) => e.eventId));

    // Step 2: Find event ids that have at least one dispatch row.
    // Events with zero dispatch rows are unseen, not fully dispatched.
    const dispatchedEvents = await tx
      .selectDistinct({ eventId: schema.outboxDispatch.eventId })
      .from(schema.outboxDispatch);

    const dispatchedIds = new Set(dispatchedEvents.map((e) => e.eventId));

    // Step 3: Find old outbox events that have dispatches but no pending ones.
    // These are fully dispatched and safe to prune.
    const oldEvents = await tx
      .select({ id: schema.outbox.id })
      .from(schema.outbox)
      .where(
        and(
          lte(schema.outbox.occurredAt, cutoff),
          eq(schema.outbox.orgId, orgId),
        ),
      );

    const eligibleIds = oldEvents
      .map((e) => e.id)
      .filter((id) => dispatchedIds.has(id) && !pendingIds.has(id));

    if (eligibleIds.length === 0) {
      return { eventsPruned: 0, dispatchesPruned: 0 };
    }

    // Step 4: Delete dispatch rows first (children before parents).
    const dispatchesDeleted = await tx
      .delete(schema.outboxDispatch)
      .where(inArray(schema.outboxDispatch.eventId, eligibleIds));

    // Step 5: Delete the outbox events themselves.
    const eventsDeleted = await tx
      .delete(schema.outbox)
      .where(inArray(schema.outbox.id, eligibleIds));

    return {
      eventsPruned: eventsDeleted.rowCount ?? 0,
      dispatchesPruned: dispatchesDeleted.rowCount ?? 0,
    };
  });
}
