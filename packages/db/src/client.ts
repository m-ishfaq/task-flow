import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';

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

/** Branded so an arbitrary string cannot be passed as an org identifier. */
export type OrgId = string & { readonly __brand: 'OrgId' };

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
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
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
    return fn(tx);
  });
}

/** Closes the pool. Shutdown only. */
export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
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
