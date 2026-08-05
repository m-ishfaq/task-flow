import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DomainEvent, OutboxWriter } from '@taskflow/events';
import type { GlobalDb, TenantDb } from './client.js';
import { outbox, outboxDispatch } from './schema/platform.js';

/**
 * The outbox — writing side and draining side (PLAN.md §10.6, guardrail 11).
 *
 * Two halves with deliberately different access:
 *
 *   `appendToOutbox`   runs inside the MUTATION's transaction, as the
 *                      application role, scoped to one org. The event and the
 *                      change it describes commit or roll back together,
 *                      which is the entire reason the table exists.
 *
 *   `claimPending` /   run in a consumer's own scope (`withAuditScope` today;
 *   `markDispatched` / a future `withRealtimeScope` for Phase 4's broadcaster)
 *   `recordFailure`    across every org. Each drains its OWN queue — one row
 *                      per (event, consumer) in `outbox_dispatch`, migration
 *                      0015 — not one shared queue, which is what makes it
 *                      safe for more than one consumer to exist at all. See
 *                      that migration for why a shared `published_at` broke
 *                      the moment a second consumer was added.
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

/** An outbox row as a consumer reads it back. */
export interface OutboxRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly version: number;
  readonly actorId: string | null;
  readonly occurredAt: Date;
  readonly requestId: string | null;
  readonly payload: unknown;
  /** This CONSUMER's attempt count — never shared with another consumer's. */
  readonly attempts: number;
}

/**
 * Claims up to `limit` events not yet dispatched to `consumer`, oldest first.
 *
 * The LEFT JOIN against `outbox_dispatch` filtered on `dispatchedAt IS NULL`
 * matches two cases identically: no dispatch row at all (never attempted),
 * and a dispatch row whose `dispatchedAt` is still null (attempted and
 * failed — see `recordFailure`). Both are "still owed to this consumer".
 *
 * `FOR UPDATE OF <outbox> SKIP LOCKED` locks only the outbox row, not the
 * (possibly absent) dispatch row — Postgres cannot lock a row a LEFT JOIN
 * didn't find, and outer-joined columns are never the thing two consumers
 * would contend on anyway. This is what lets a second instance of the SAME
 * consumer start without coordination: each claims a disjoint set instead of
 * both blocking on the same head row. Two DIFFERENT consumers were never
 * contending on this table to begin with — a realtime claim and an audit
 * claim touch disjoint `outbox_dispatch` rows regardless of locking, which is
 * the entire point of the table.
 */
export async function claimPending(
  tx: GlobalDb,
  consumer: string,
  limit = 100,
): Promise<readonly OutboxRow[]> {
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
      attempts: sql<number>`coalesce(${outboxDispatch.attempts}, 0)`.as('attempts'),
    })
    .from(outbox)
    .leftJoin(
      outboxDispatch,
      and(eq(outboxDispatch.eventId, outbox.id), eq(outboxDispatch.consumer, consumer)),
    )
    .where(isNull(outboxDispatch.dispatchedAt))
    .orderBy(asc(outbox.occurredAt), asc(outbox.id))
    .limit(limit)
    .for('update', { of: outbox, skipLocked: true });

  return rows;
}

/**
 * Marks events dispatched TO `consumer`. Called in the same transaction that
 * claimed them, from that consumer's own scope.
 *
 * `onConflictDoUpdate` rather than a bare insert: a row can already exist
 * here from a PRIOR failed attempt (`recordFailure` below inserted one with
 * `dispatchedAt` still null), and this call is what finally sets it.
 */
export async function markDispatched(
  tx: GlobalDb,
  consumer: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  await tx
    .insert(outboxDispatch)
    .values(ids.map((id) => ({ eventId: id, consumer, dispatchedAt: new Date() })))
    .onConflictDoUpdate({
      target: [outboxDispatch.eventId, outboxDispatch.consumer],
      set: { dispatchedAt: sql`excluded.dispatched_at` },
    });
}

/**
 * Records a failed dispatch attempt for `consumer`, without marking the event
 * dispatched.
 *
 * The row stays claimable BY THIS CONSUMER — another consumer's dispatch
 * state for the same event is a different row entirely, so one consumer
 * failing never blocks another's delivery. `attempts` is what a
 * poison-message check reads: an event failing forever must eventually stop
 * blocking the ones behind it, and that decision needs a count to make.
 */
export async function recordFailure(
  tx: GlobalDb,
  consumer: string,
  id: string,
  error: string,
): Promise<void> {
  await tx
    .insert(outboxDispatch)
    .values({
      eventId: id,
      consumer,
      attempts: 1,
      // Bounded: an error message is diagnostic, and an unbounded one from a
      // driver that echoes the failing statement would put the event's own
      // payload back into the row it failed on.
      lastError: error.slice(0, 1000),
    })
    .onConflictDoUpdate({
      target: [outboxDispatch.eventId, outboxDispatch.consumer],
      set: {
        attempts: sql`${outboxDispatch.attempts} + 1`,
        lastError: error.slice(0, 1000),
      },
    });
}
