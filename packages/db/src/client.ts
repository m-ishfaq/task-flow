import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { OrgId, UserId } from '@taskflow/contracts';

/**
 * The tenant-scoped data layer — guardrail 2 (PLAN.md §2.1, §8.3).
 *
 * This module is the ONLY place in the workspace permitted to construct a
 * database connection. Everything else receives an already-scoped handle. The
 * ESLint guardrails ban importing `pg`, `drizzle-orm/node-postgres`, or this
 * module's internals from feature code, so there is no supported way to obtain
 * an unscoped connection outside these few lines.
 *
 * How isolation actually works, in layers:
 *
 *   1. `withOrgScope` opens a transaction and issues
 *      `SET LOCAL app.org_id = <verified org>`.
 *   2. Every tenant table carries an RLS policy comparing `org_id` against that
 *      setting (§8.3).
 *   3. The pool authenticates as `taskflow_app`, which has NOBYPASSRLS.
 *
 * The consequence: a query that forgets its org filter returns zero rows rather
 * than another tenant's data. That is the property that makes AI-assisted
 * development of a multi-tenant system defensible.
 */

const { Pool } = pg;

/**
 * Re-exported from @taskflow/contracts rather than defined here.
 *
 * A locally-declared `OrgId` would be structurally distinct from the shared one,
 * so an id parsed at the API boundary would not be assignable here — and the
 * usual fix for that is a cast, which defeats guardrail 1 entirely.
 */
export type { OrgId, UserId } from '@taskflow/contracts';

export interface DbConfig {
  /** Connection string for the RLS-enforced application role. */
  readonly url: string;
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

/** A handle already bound to one organization's rows. */
export type TenantDb = NodePgDatabase;

/** A handle with NO tenant scoping. See `withGlobalScope`. */
export type GlobalDb = NodePgDatabase;

let pool: pg.Pool | undefined;
let db: NodePgDatabase | undefined;

/** Initializes the pool. Called once at service boot, never by feature code. */
export function initializeDatabase(config: DbConfig): void {
  if (pool) {
    throw new Error('Database already initialized. initializeDatabase() is a boot-time call.');
  }

  pool = new Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    application_name: config.applicationName ?? 'taskflow',
    // Fail fast rather than queueing behind an exhausted pool.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  db = drizzle(pool);
}

function requireDb(): NodePgDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() during boot.');
  }
  return db;
}

/**
 * Runs `fn` scoped to a single organization.
 *
 * The callback shape is deliberate and not negotiable. `SET LOCAL` is
 * transaction-scoped, so returning a bare "scoped client" would let callers hold
 * a handle whose scope had already ended — silently reverting to unscoped
 * queries on a pooled connection that another tenant's request may reuse. Tying
 * scope to a transaction's lifetime makes that impossible to express.
 *
 * `orgId` must come from a verified token, never from a request parameter.
 */
export async function withOrgScope<T>(orgId: OrgId, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  return requireDb().transaction(async (tx) => {
    // Parameterized: org_id reaches Postgres as a value, never as SQL text.
    //
    // `app.user_id` is cleared, not merely left alone. Permissive RLS policies
    // are OR'ed, so the self-read policies on identity.memberships and
    // identity.orgs would widen this transaction past its org if a user scope
    // from an earlier transaction on the same pooled connection survived.
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` scoped to one USER, across every organization.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * There is exactly one question this exists for: "which organizations am I a
 * member of?" No value of `app.org_id` answers it, because the answer spans
 * orgs by definition — and it is the first thing a client needs after signing
 * in, before there is an org to scope to.
 *
 * What it does NOT do is grant broad access. Only two policies consult
 * `app.user_id`, both `FOR SELECT`, both on the caller's own membership rows
 * (see `selfPredicate` in rls.ts). Every other tenant table still filters on
 * `app.org_id`, which this clears — so a query for cards in this scope returns
 * zero rows, exactly as it would with no scope at all.
 *
 * `userId` must come from a verified token, never from a request parameter.
 */
export async function withUserScope<T>(
  userId: UserId,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  return requireDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` with NO tenant scoping. Every RLS policy will filter to zero rows.
 *
 * This exists for the genuinely pre-tenant operations — looking a user up by
 * email at login, resolving an invitation token, reading a public share link —
 * where no organization is known yet, by definition.
 *
 * Rules:
 *   - Only tables WITHOUT tenant RLS may be queried here. A tenant table
 *     queried in this scope returns nothing, which is the correct failure.
 *   - Every call site needs a comment explaining why no org is known.
 *   - Restricted by lint to the identity module (Phase 1); adding a call site
 *     elsewhere is a change to a security-critical surface (§2.2).
 */
export async function withGlobalScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  return requireDb().transaction(async (tx) => {
    // Explicitly clear rather than assume: pooled connections are reused, and an
    // inherited org_id from a previous transaction would be far worse than none.
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/* -------------------------------------------------------------------------- *
 * The audit connection (§8.6)
 * -------------------------------------------------------------------------- */

let auditPool: pg.Pool | undefined;
let auditDb: NodePgDatabase | undefined;

/**
 * Initializes the audit pool. Optional — a service that never writes audit
 * entries (the API today; the worker eventually owns the projection) does not
 * call this, and `withAuditScope` then refuses rather than silently falling
 * back to the application role.
 */
export function initializeAuditDatabase(config: DbConfig): void {
  if (auditPool) {
    throw new Error('Audit database already initialized. This is a boot-time call.');
  }

  auditPool = new Pool({
    connectionString: config.url,
    // Deliberately small. One relay drains the outbox; a large pool here would
    // only add ways for the audit chain's per-org lock to contend with itself.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-audit',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  auditDb = drizzle(auditPool);
}

/**
 * Runs `fn` as `taskflow_audit` — the role that may INSERT audit entries and
 * drain the outbox, and that holds no UPDATE or DELETE anywhere.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * NOT tenant-scoped, and it cannot be: one relay drains one queue across every
 * org, so no value of `app.org_id` is right for it. What contains that is not a
 * session variable but the role itself — `taskflow_audit` is `NOBYPASSRLS`, and
 * reaches across orgs only on the two tables carrying an explicit
 * `TO taskflow_audit` policy (platform.outbox, audit.audit_log). Every other
 * table in the database still filters on `app.org_id`, which this clears, so a
 * stray query for cards here returns zero rows.
 *
 * The org context is cleared rather than left alone for the usual pooled-
 * connection reason, and because a *set* org here would silently narrow the
 * relay to one tenant — a backlog that stops draining for everyone else and
 * looks, from the outside, like nothing happening.
 */
export async function withAuditScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!auditDb) {
    throw new Error(
      'Audit database not initialized. Call initializeAuditDatabase() during boot — ' +
        'audit entries must not fall back to the application role, which cannot write them.',
    );
  }

  return auditDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the audit pool has been initialized. */
export function hasAuditDatabase(): boolean {
  return auditDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The realtime connection (ai/phase-4-realtime.md §3.5)
 * -------------------------------------------------------------------------- */

let realtimePool: pg.Pool | undefined;
let realtimeDb: NodePgDatabase | undefined;

/**
 * The realtime role's connection string, kept for the dedicated LISTEN
 * connection in `notify.ts`.
 *
 * That listener needs a `pg.Client` of its own rather than a pooled one: a
 * LISTEN registered on a pooled connection is lost the moment that connection
 * is returned to the pool — silently, leaving a listener that never fires and a
 * gateway that has quietly degraded to the poll interval. It reads the URL from
 * here rather than taking a second copy from the caller, so the gateway's
 * credentials enter this package in exactly one place.
 */
let realtimeUrl: string | undefined;

/**
 * Initializes the realtime consumer's pool — the socket gateway's own drain
 * connection, as `taskflow_realtime`.
 *
 * A FOURTH role rather than reusing `taskflow_audit`, which is the entire point
 * of migration 0015's per-consumer dispatch table: the gateway holds nothing on
 * `audit.audit_log`, and migration 0016's `WITH CHECK (consumer = 'realtime')`
 * means it cannot mark an event dispatched to audit even if it asked to.
 */
export function initializeRealtimeDatabase(config: DbConfig): void {
  if (realtimePool) {
    throw new Error('Realtime database already initialized. This is a boot-time call.');
  }

  realtimePool = new Pool({
    connectionString: config.url,
    // Small, for the same reason as the audit pool: one relay drains the queue,
    // and extra connections here buy nothing but ways to contend.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-realtime',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  realtimeDb = drizzle(realtimePool);
  realtimeUrl = config.url;
}

/**
 * Runs `fn` as `taskflow_realtime` — the role that may read `platform.outbox`
 * across every org and write its OWN dispatch bookkeeping, and nothing else.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * NOT tenant-scoped, for the same reason `withAuditScope` is not: one relay
 * drains one queue across every org, so no value of `app.org_id` is right for
 * it. What contains it is the role — `NOBYPASSRLS`, reaching across orgs only
 * on the two tables carrying an explicit `TO taskflow_realtime` policy.
 *
 * This is NOT the connection the gateway authorizes on. Membership and tuple
 * reads go through `withOrgScope`/`withUserScope` on the ordinary application
 * pool, under RLS, exactly as the API does them — the gateway asks the same
 * `can()` with the same inputs (§6.2), and a second privileged path for it to
 * ask on would be the thing that section forbids.
 */
export async function withRealtimeScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!realtimeDb) {
    throw new Error(
      'Realtime database not initialized. Call initializeRealtimeDatabase() during boot — ' +
        'the broadcaster must not fall back to the application role, which cannot read the ' +
        'outbox across orgs and would silently drain nothing.',
    );
  }

  return realtimeDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the realtime pool has been initialized. */
export function hasRealtimeDatabase(): boolean {
  return realtimeDb !== undefined;
}

/** @internal — for notify.ts. Not re-exported from the package index. */
export function realtimeConnectionString(): string | undefined {
  return realtimeUrl;
}

let adapterPool: pg.Pool | undefined;

/**
 * A dedicated pool for `@socket.io/postgres-adapter`.
 *
 * ## Why this is here and not in apps/realtime
 *
 * The adapter's constructor takes a `pg.Pool`. Building one in the gateway would
 * mean importing `pg` there, which guardrail 2 bans — and the ban is not a
 * formality: the value of "one file constructs every connection" is that there
 * is one place to audit which credentials exist and what they can reach. So the
 * construction stays here, and the gateway receives an opaque handle it passes
 * straight to the adapter without ever naming `pg` itself.
 *
 * It is NOT the pool `withRealtimeScope` uses. The adapter holds a connection
 * open indefinitely for its own LISTEN, and handing it one of the two
 * connections the drain loop shares would leave the relay contending with the
 * broadcast fan-out for the pool it needs to make progress — a gateway that
 * gets slower the more it is used, which is the hardest kind of problem to
 * attribute.
 *
 * The tables the adapter touches are created by migration 0016, under RLS with
 * a policy naming this role: the payloads it buffers are broadcast packets, so
 * they carry tenant data, and `taskflow_app` having no way to read them is a
 * real property rather than a formality.
 */
export function createRealtimeAdapterPool(): pg.Pool {
  if (realtimeUrl === undefined) {
    throw new Error(
      'Realtime database not initialized. Call initializeRealtimeDatabase() during boot.',
    );
  }
  if (adapterPool) return adapterPool;

  adapterPool = new Pool({
    connectionString: realtimeUrl,
    max: 2,
    application_name: 'taskflow-realtime-adapter',
    connectionTimeoutMillis: 5_000,
    // No idle timeout: the adapter's LISTEN connection is supposed to sit idle,
    // and reaping it would silently stop cross-instance delivery.
    idleTimeoutMillis: 0,
  });

  return adapterPool;
}

/* -------------------------------------------------------------------------- *
 * The collab connection (ai/phase-6-docs.md §6.1, Phase 6 Wave 2)
 * -------------------------------------------------------------------------- */

let collabPool: pg.Pool | undefined;
let collabDb: NodePgDatabase | undefined;

/**
 * Initializes `apps/collab`'s write-exception pool, as `taskflow_collab`.
 *
 * Unlike `taskflow_realtime`, this role IS tenant-scoped ordinary data —
 * `docs.yjs_updates` and `docs.page_versions` carry `org_id` under the same
 * `tenant_isolation` RLS policy every other table gets, not a per-consumer
 * one. `withCollabScope` below sets `app.org_id` exactly like `withOrgScope`
 * does; the separate ROLE is what's narrow — INSERT/SELECT on those two
 * tables and DELETE on the WAL, nothing else — not a separate scoping model.
 */
export function initializeCollabDatabase(config: DbConfig): void {
  if (collabPool) {
    throw new Error('Collab database already initialized. This is a boot-time call.');
  }

  collabPool = new Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    application_name: config.applicationName ?? 'taskflow-collab',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  collabDb = drizzle(collabPool);
}

/**
 * Runs `fn` as `taskflow_collab`, scoped to one organization.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — the write path guardrail 8's "sockets
 * never write" carve-out is about. `apps/collab`'s `onAuthenticate` hook
 * still reads `docs.pages`/`docs.spaces` over the ORDINARY `withOrgScope`
 * (the `taskflow_app` pool `initializeDatabase` sets up) — this connection
 * exists for exactly one thing: persisting to `docs.yjs_updates` and
 * `docs.page_versions`, the two tables `taskflow_collab` can reach.
 */
export async function withCollabScope<T>(orgId: OrgId, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  if (!collabDb) {
    throw new Error(
      'Collab database not initialized. Call initializeCollabDatabase() during boot — ' +
        'the WAL append must not fall back to the application role, which has no grant on ' +
        'docs.yjs_updates or docs.page_versions and would fail closed on every write.',
    );
  }

  return collabDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the collab pool has been initialized. */
export function hasCollabDatabase(): boolean {
  return collabDb !== undefined;
}

/** Closes every pool. Shutdown only. */
export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;

  await auditPool?.end();
  auditPool = undefined;
  auditDb = undefined;

  await realtimePool?.end();
  realtimePool = undefined;
  realtimeDb = undefined;
  realtimeUrl = undefined;

  await adapterPool?.end();
  adapterPool = undefined;

  await collabPool?.end();
  collabPool = undefined;
  collabDb = undefined;
}

/** True when the pool is live and answering. Backs `/health/ready` (§14). */
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await requireDb().execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
