# Architecture reference

Condensed from PLAN.md for day-to-day work. When the two disagree, PLAN.md wins.

## Shape

```
Browser ──tRPC──> apps/api ──> packages/db ──> Postgres (RLS)
   │                 │
   │                 ├──> pg-boss queue ──> apps/worker
   │                 └──> emits domain events
   ├──socket.io──> apps/realtime      (broadcast only, never writes)
   └──y-websocket─> apps/collab       (Yjs CRDT — the one write exception)
```

## Why the pieces are as they are

**PostgreSQL over MongoDB** — RLS. There is no document-store equivalent, and RLS is the layer
that makes AI-assisted multi-tenant development defensible. It is the reason a forgotten filter
is a bug rather than a breach.

**Drizzle over Prisma** — SQL-first, no engine binary, composes cleanly with RLS session
variables and transaction-scoped context.

**tRPC internally, OpenAPI publicly** — compile-time contract safety for our own client, without
giving up a versioned public API.

**Fastify over Express/Nest** — speed, schema-first validation. The fail-closed route builder
replaces Nest's guards with something enforced by the type system rather than by remembering to
attach a decorator.

**pg-boss over BullMQ** — job enqueue participates in the same transaction as the mutation that
caused it. No "job fired but the write rolled back." Also removes Redis entirely at current
scale.

**No repository layer** — Drizzle is already the data-access abstraction. A tier on top buys
nothing until there is a second datastore.

## Isolation, in four layers

A bug in any one layer does not produce a breach:

1. Route declares required permission — compile-time enforced
2. Policy engine evaluates role + relationship tuples + resource attributes
3. Tenant-scoped data layer injects org context
4. Postgres RLS refuses cross-tenant rows regardless of application logic

## Data access

```ts
const cards = await withOrgScope(ctx.orgId, async (tx) =>
  tx.select().from(schema.cards).where(eq(schema.cards.boardId, boardId)),
);
```

No `org_id` in the WHERE clause — deliberately. RLS applies it. The callback shape exists
because `SET LOCAL` is transaction-scoped: a returned "scoped client" could outlive its scope
and silently revert to unscoped queries on a pooled connection.

`withGlobalScope` exists only for genuinely pre-tenant operations (login by email, invitation
tokens). It returns zero rows from any tenant table.

## Database roles

| Role                | Purpose         | Notes                                           |
| ------------------- | --------------- | ----------------------------------------------- |
| `taskflow_migrator` | DDL, migrations | Only role with `CREATE ON DATABASE`             |
| `taskflow_app`      | Runtime         | `NOBYPASSRLS` — the load-bearing attribute      |
| `taskflow_audit`    | Audit writes    | `INSERT`/`SELECT` only, never `UPDATE`/`DELETE` |

Each schema needs `GRANT USAGE ... TO taskflow_app` plus default privileges, or the app gets
"permission denied for schema" before RLS is ever consulted.

## Card ordering (Phase 3)

Fractional indexing, base-62 string ranks, sorted `(rank, id)`. The move API takes **neighbours**
(`beforeCardId` / `afterCardId`), never a computed rank — so concurrent drags converge instead of
fighting over an index. A rebalance job handles rank-string growth.

## Frontend state

- Server state → TanStack Query, always.
- Client state → Zustand, only for things with no server representation.
- **Never mirror server data into Zustand.** This is the most common way apps like this rot.

Socket events patch the query cache from exactly one module.

## Roadmap position

Phases 0–4 are a shared foundation every product depends on and do not parallelize. Everything
from Phase 5 (Chat, Docs, Telephony, Search, Automation, Analytics) is behind a feature flag and
independently deployable.
