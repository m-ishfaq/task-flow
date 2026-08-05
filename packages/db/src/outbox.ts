import { sql } from 'drizzle-orm';
import type { DomainEvent, OutboxWriter } from '@taskflow/events';
import type { GlobalDb, TenantDb } from './client.js';
import { outbox, outboxDispatch } from './schema/platform.js';
import { instant } from './audit-log.js';

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

/** Narrows an unknown raw-row column to text, without stringifying an object into it. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Narrows a raw-row column that the schema guarantees is present — `id`,
 * `orgId`, `name` are all `NOT NULL` on `platform.outbox`.
 *
 * Throws rather than falling back to `''`, matching `instant()` above. A
 * silent empty string here does not fail where the invariant actually
 * broke: it would flow into `markDispatched`'s `event_id`, which fails on
 * the foreign key to `outbox.id` — a confusing error several calls away
 * from a raw SQL row that did not have the shape this function assumed.
 */
function required(column: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected ${column} from platform.outbox, received ${typeof value}.`);
  }
  return value;
}

/**
 * Claims up to `limit` events not yet dispatched to `consumer`, oldest first.
 *
 * Raw SQL (`tx.execute`), not the query builder — see `audit-log.ts` for the
 * same choice made for the same kind of reason. Here it is `FOR UPDATE OF`:
 * Postgres requires an UNQUALIFIED relation name in that clause ("FOR UPDATE
 * must specify unqualified relation names"), but `.for('update', { of: outbox
 * })` renders the fully schema-qualified `"platform"."outbox"` — there is no
 * builder option to ask for just the bare name. Aliasing the table in the
 * FROM clause (`platform.outbox o`) and writing `FOR UPDATE OF o` satisfies
 * Postgres AND keeps the lock scoped to the outbox row alone, not the
 * (possibly absent) dispatch row — which matters because Postgres also
 * refuses a bare `FOR UPDATE` with no `OF` when the query outer-joins a
 * table that may have no matching row ("FOR UPDATE cannot be applied to the
 * nullable side of an outer join"). `o` alone avoids both errors at once.
 *
 * The LEFT JOIN against `outbox_dispatch` filtered on `dispatched_at IS
 * NULL` matches two cases identically: no dispatch row at all (never
 * attempted), and a dispatch row whose `dispatched_at` is still null
 * (attempted and failed — see `recordFailure`). Both are "still owed to this
 * consumer". Locking only `o` is what lets a second instance of the SAME
 * consumer start without coordination — each claims a disjoint set instead
 * of both blocking on the same head row. Two DIFFERENT consumers were never
 * contending on this table to begin with: a realtime claim and an audit
 * claim touch disjoint `outbox_dispatch` rows regardless of locking, which
 * is the entire point of the table.
 *
 * `instant()` (from `audit-log.ts`) is needed for the same reason it is
 * there: raw `tx.execute` does not run the column through drizzle's
 * schema-aware type mapping, so `occurred_at` arrives as the text Postgres
 * rendered, not a `Date`.
 */
export async function claimPending(
  tx: GlobalDb,
  consumer: string,
  limit = 100,
): Promise<readonly OutboxRow[]> {
  const result = await tx.execute(sql`
    SELECT o.id::text            AS id,
           o.org_id::text        AS org_id,
           o.name                AS name,
           o.version              AS version,
           o.actor_id::text      AS actor_id,
           o.occurred_at          AS occurred_at,
           o.request_id           AS request_id,
           o.payload              AS payload,
           coalesce(d.attempts, 0) AS attempts
      FROM platform.outbox o
      LEFT JOIN platform.outbox_dispatch d
        ON d.event_id = o.id AND d.consumer = ${consumer}
     WHERE d.dispatched_at IS NULL
     ORDER BY o.occurred_at, o.id
     LIMIT ${limit}
       FOR UPDATE OF o SKIP LOCKED
  `);

  return result.rows.map((row): OutboxRow => {
    const record: Record<string, unknown> = row;
    return {
      id: required('id', record['id']),
      orgId: required('org_id', record['org_id']),
      name: required('name', record['name']),
      version: Number(record['version']),
      actorId: text(record['actor_id']),
      occurredAt: instant(record['occurred_at']),
      requestId: text(record['request_id']),
      payload: record['payload'],
      attempts: Number(record['attempts']),
    };
  });
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
