import { asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DomainEvent, OutboxWriter } from '@taskflow/events';
import type { GlobalDb, TenantDb } from './client.js';
import { outbox } from './schema/platform.js';

/**
 * The outbox — writing side and draining side (PLAN.md §10.6, guardrail 11).
 *
 * Two halves with deliberately different access:
 *
 *   `appendToOutbox`  runs inside the MUTATION's transaction, as the
 *                     application role, scoped to one org. The event and the
 *                     change it describes commit or roll back together, which
 *                     is the entire reason the table exists.
 *
 *   `claimPending` /  run in `withAuditScope`, as taskflow_audit, across every
 *   `markPublished`   org. The relay drains one queue, not one tenant's queue.
 */

/**
 * Appends events to the outbox within the caller's transaction.
 *
 * There is no org parameter, and that is not an oversight: the transaction is
 * already scoped, and the RLS `WITH CHECK` on platform.outbox rejects any event
 * whose `orgId` differs from the scope. So a service that assembles an event
 * for the wrong tenant fails loudly at the database rather than writing a
 * cross-tenant event that five consumers then act on.
 */
export async function appendToOutbox(
  tx: TenantDb,
  events: readonly DomainEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  await tx.insert(outbox).values(
    events.map((event) => ({
      id: event.id,
      orgId: event.orgId,
      name: event.name,
      version: event.version,
      actorId: event.actorId,
      // The envelope carries an ISO string so it survives a queue round-trip
      // unchanged; the column is a timestamptz.
      occurredAt: new Date(event.occurredAt),
      requestId: event.requestId ?? null,
      payload: event.payload,
    })),
  );

  return events.length;
}

/**
 * The `OutboxWriter` from @taskflow/events, bound to a tenant transaction.
 *
 * Services call `outboxWriter.append(tx, events)` rather than the bare function
 * above, for two reasons that both matter: it is the interface that package
 * declares, so a second implementation (a test double, a different store) is
 * substitutable — and guardrail 11's lint rule recognizes `.append(...)` as an
 * emission. A free function would satisfy the type checker and leave every
 * service in this module reported as mutating without emitting.
 */
export const outboxWriter: OutboxWriter<TenantDb> = {
  append: async (tx, events) => {
    await appendToOutbox(tx, events);
  },
};

/** An outbox row as the relay reads it back. */
export interface OutboxRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly version: number;
  readonly actorId: string | null;
  readonly occurredAt: Date;
  readonly requestId: string | null;
  readonly payload: unknown;
  readonly attempts: number;
}

/**
 * Claims up to `limit` undispatched events, oldest first.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets a second relay instance start without
 * coordination: each claims a disjoint set instead of both blocking on the same
 * head row. Rows stay claimed only for the life of the transaction, so a relay
 * that dies mid-batch releases them rather than stranding the backlog.
 */
export async function claimPending(tx: GlobalDb, limit = 100): Promise<readonly OutboxRow[]> {
  const rows = await tx
    .select({
      id: outbox.id,
      orgId: outbox.orgId,
      name: outbox.name,
      version: outbox.version,
      actorId: outbox.actorId,
      occurredAt: outbox.occurredAt,
      requestId: outbox.requestId,
      payload: outbox.payload,
      attempts: outbox.attempts,
    })
    .from(outbox)
    .where(isNull(outbox.publishedAt))
    .orderBy(asc(outbox.occurredAt), asc(outbox.id))
    .limit(limit)
    .for('update', { skipLocked: true });

  return rows;
}

/** Marks events dispatched. Called in the same transaction that claimed them. */
export async function markPublished(tx: GlobalDb, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  await tx
    .update(outbox)
    .set({ publishedAt: new Date() })
    .where(inArray(outbox.id, [...ids]));
}

/**
 * Records a failed dispatch attempt without marking the event published.
 *
 * The row stays claimable, so delivery is retried. `attempts` is what a
 * poison-message check reads: an event failing forever must eventually stop
 * blocking the ones behind it, and that decision needs a count to make.
 */
export async function recordFailure(tx: GlobalDb, id: string, error: string): Promise<void> {
  await tx
    .update(outbox)
    .set({
      attempts: sql`${outbox.attempts} + 1`,
      // Bounded: an error message is diagnostic, and an unbounded one from a
      // driver that echoes the failing statement would put the event's own
      // payload back into the row it failed on.
      lastError: error.slice(0, 1000),
    })
    .where(eq(outbox.id, id));
}
