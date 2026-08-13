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
export async function withCollabScope<T>(
  orgId: OrgId,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
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

/* -------------------------------------------------------------------------- *
 * The notification-sweep connection (ai/phase-9-notifications.md §3.8,
 * Phase 9 Wave 2)
 * -------------------------------------------------------------------------- */

let sweepPool: pg.Pool | undefined;
let sweepDb: NodePgDatabase | undefined;

/**
 * Initializes the due-reminder sweep's pool, as `taskflow_notification_sweep`.
 *
 * A SIXTH role, for the identical reason `taskflow_backlinks` is a fifth and
 * `taskflow_realtime` a fourth: the scan reads `work.cards` across every
 * tenant in one pass, and no value of `app.org_id` is correct for it. Its
 * grant on `work.cards` is COLUMN-LEVEL — id/org_id/board_id/title/number/
 * due_date/assignee_ids, never description or rank — plus SELECT on
 * `notification_prefs` and SELECT/INSERT on `platform.notifications` and
 * `notification_deliveries`. Migration 0029's own header has the detail,
 * including why the delivery-row grant is a deliberate extension of the
 * plan's §3.8 letter.
 */
export function initializeSweepDatabase(config: DbConfig): void {
  if (sweepPool) {
    throw new Error('Sweep database already initialized. This is a boot-time call.');
  }

  sweepPool = new Pool({
    connectionString: config.url,
    // Small, matching every other system role: one sweep runs per tick, and
    // extra connections here buy nothing but ways to contend.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-notification-sweep',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  sweepDb = drizzle(sweepPool);
}

/**
 * Runs `fn` as `taskflow_notification_sweep` — the role that may scan every
 * tenant's cards for due dates and write `card.due_soon` notification rows.
 *
 * NOT tenant-scoped, for the identical reason `withBacklinksScope` is not:
 * one sweep tick scans across every tenant, so no single value of
 * `app.org_id` is correct for it. What contains it is the role —
 * `NOBYPASSRLS`, reaching across orgs only on the tables carrying an
 * explicit `TO taskflow_notification_sweep` policy, and on `work.cards` only
 * through the column-level grant migration 0029 applies.
 */
export async function withSweepScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!sweepDb) {
    throw new Error(
      'Sweep database not initialized. Call initializeSweepDatabase() during boot — ' +
        'the due-reminder scan must not fall back to the application role, which cannot see ' +
        'work.cards across every org and would silently scan nothing.',
    );
  }

  return sweepDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the sweep pool has been initialized. */
export function hasSweepDatabase(): boolean {
  return sweepDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The recording-ingest connection (ai/phase-7-voice.md §3.6, Phase 7 Wave 2)
 * -------------------------------------------------------------------------- */

let recordingIngestPool: pg.Pool | undefined;
let recordingIngestDb: NodePgDatabase | undefined;

/**
 * Initializes the recording-ingest pool, as `taskflow_recording_ingest`.
 *
 * A SEVENTH role, on the same reasoning as every consumer role before it: the
 * sweep pulls pending recordings off the carrier for every tenant in one pass,
 * and no value of `app.org_id` is correct for it.
 *
 * Migration 0033 has the column-level detail. The short version: this role can
 * read which recordings are pending and where the carrier says the audio is,
 * and holds NOTHING on `comms.calls` — so the role that fetches a recording
 * cannot learn whose conversation it is. It also has no INSERT anywhere, so a
 * compromised sweep cannot fabricate a recording row pointing at an object it
 * controls.
 */
export function initializeRecordingIngestDatabase(config: DbConfig): void {
  if (recordingIngestPool) {
    throw new Error('Recording ingest database already initialized. This is a boot-time call.');
  }

  recordingIngestPool = new Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-recording-ingest',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  recordingIngestDb = drizzle(recordingIngestPool);
}

/**
 * Runs `fn` as `taskflow_recording_ingest`.
 *
 * Throws rather than falling back to the application role — which could not see
 * pending recordings across every org anyway, so the fallback would silently
 * ingest nothing while looking healthy. That failure shape is exactly what
 * Phase 4's `FOR UPDATE`-without-an-UPDATE-policy bug looked like, and the
 * reason every consumer scope in this file refuses instead of degrading.
 */
export async function withRecordingIngestScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!recordingIngestDb) {
    throw new Error(
      'Recording ingest database not initialized. Call initializeRecordingIngestDatabase() ' +
        'during boot — the ingest sweep must not fall back to the application role, which ' +
        'cannot see comms.recordings across every org and would silently ingest nothing.',
    );
  }

  return recordingIngestDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the recording-ingest pool has been initialized. */
export function hasRecordingIngestDatabase(): boolean {
  return recordingIngestDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The platform-admin connection (ai/phase-12-admin.md §3.7, Phase 12 Wave 1)
 * -------------------------------------------------------------------------- */

let platformAdminPool: pg.Pool | undefined;
let platformAdminDb: NodePgDatabase | undefined;

/**
 * Initializes the platform-admin console's pool, as `taskflow_platform_admin`.
 *
 * AN EIGHTH role, for the identical reason every consumer role before it
 * exists: the org DIRECTORY is read across EVERY tenant in one pass, and no
 * value of `app.org_id` is correct for it. The role is `NOBYPASSRLS`, reaching
 * across orgs only on the tables carrying an explicit
 * `TO taskflow_platform_admin` policy (migration 0035): `identity.orgs` and
 * `identity.memberships` for the directory, `identity.users` (which has no
 * RLS at all), and the operator audit log it owns.
 *
 * This is NOT the connection `isPlatformOperator` reads on: that check goes
 * through `withGlobalScope` on the ordinary application pool, because
 * `platform.operators` is a non-tenant table with no RLS and the app role
 * holds SELECT on it.
 */
export function initializePlatformAdminDatabase(config: DbConfig): void {
  if (platformAdminPool) {
    throw new Error('Platform-admin database already initialized. This is a boot-time call.');
  }

  platformAdminPool = new Pool({
    connectionString: config.url,
    // Small, matching every other system role: one console session at a time,
    // and extra connections here buy nothing but ways to contend.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-platform-admin',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  platformAdminDb = drizzle(platformAdminPool);
}

/**
 * Runs `fn` as `taskflow_platform_admin` — the role that may read the org
 * directory across every tenant and write `identity.orgs.status`.
 *
 * NOT tenant-scoped, for the identical reason `withAuditScope` is not: the
 * console's queries span every org, so no single value of `app.org_id` is
 * correct for it. What contains it is the role — `NOBYPASSRLS`, reaching
 * across orgs only on the tables carrying an explicit
 * `TO taskflow_platform_admin` policy. Every OTHER table still filters on
 * `app.org_id`, which this clears, so a stray query for cards here returns
 * zero rows.
 *
 * Throws rather than falling back to the application role — which could not
 * see across every org anyway, so the fallback would silently list zero orgs
 * while looking healthy. That is exactly the quiet failure §3.7 exists to
 * prevent (an operator looking at a real system with real orgs misreading an
 * empty list as "no orgs exist yet").
 */
export async function withPlatformAdminScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!platformAdminDb) {
    throw new Error(
      'Platform-admin database not initialized. Call initializePlatformAdminDatabase() during ' +
        'boot — the console must not fall back to the application role, which cannot see ' +
        'identity.orgs across every tenant and would silently list nothing.',
    );
  }

  return platformAdminDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the platform-admin pool has been initialized. */
export function hasPlatformAdminDatabase(): boolean {
  return platformAdminDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The backlinks connection (ai/phase-6-docs.md §3.10, Phase 6 Wave 3)
 * -------------------------------------------------------------------------- */

let backlinksPool: pg.Pool | undefined;
let backlinksDb: NodePgDatabase | undefined;

/**
 * Initializes the backlinks relay's claim pool, as `taskflow_backlinks`.
 *
 * A FIFTH role rather than reusing `taskflow_app` for the claim step, for
 * the same reason `taskflow_realtime` isn't `taskflow_audit`: the claim
 * query has to see every tenant's `docs.page_versions` rows in one pass, and
 * no ordinary org-scoped connection can do that. Migration 0025's own header
 * has the column-level detail — this role's grant on `docs.page_versions` is
 * `(id, org_id, page_id, created_at)` only, never `state`.
 */
export function initializeBacklinksDatabase(config: DbConfig): void {
  if (backlinksPool) {
    throw new Error('Backlinks database already initialized. This is a boot-time call.');
  }

  backlinksPool = new Pool({
    connectionString: config.url,
    // Small, matching taskflow_audit/taskflow_realtime: one relay drains one
    // queue, and extra connections here buy nothing but ways to contend.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-backlinks',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  backlinksDb = drizzle(backlinksPool);
}

/**
 * Runs `fn` as `taskflow_backlinks` — the role that may find out WHICH
 * pages have a new `page_versions` row across every org, and mark it
 * processed. It cannot read `state` (migration 0025) and holds nothing on
 * `docs.backlinks`; the actual link extraction and backlinks write happen
 * afterward, per claimed page, over the ordinary `withOrgScope` connection —
 * see `apps/api/src/docs/backlinks.relay.ts`.
 *
 * NOT tenant-scoped, for the identical reason `withAuditScope` and
 * `withRealtimeScope` are not: one relay tick claims across every tenant, so
 * no single value of `app.org_id` is correct for it.
 */
export async function withBacklinksScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!backlinksDb) {
    throw new Error(
      'Backlinks database not initialized. Call initializeBacklinksDatabase() during boot — ' +
        'the relay must not fall back to the application role, which cannot see docs.page_versions ' +
        'across every org and would silently claim nothing.',
    );
  }

  return backlinksDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the backlinks pool has been initialized. */
export function hasBacklinksDatabase(): boolean {
  return backlinksDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The search-claim connection (ai/phase-8-search.md §2.3, Phase 8 Wave 2,
 * migration 0045)
 * -------------------------------------------------------------------------- */

let searchPool: pg.Pool | undefined;
let searchDb: NodePgDatabase | undefined;

/**
 * Initializes the search indexer's claim pool, as `taskflow_search`.
 *
 * A NINTH role, on the identical reasoning every consumer role before it
 * exists: the claim query reads `platform.outbox` and `outbox_dispatch`
 * across EVERY tenant in one pass, and no value of `app.org_id` is correct
 * for it. Migration 0045 gives it exactly the 0016 recipe — SELECT on the
 * outbox plus the UPDATE-with-`WITH CHECK (false)` policy that `FOR UPDATE`
 * locking selects require — and nothing at all on `search.documents`: the
 * actual indexing happens afterward, per event, over the ordinary
 * `withOrgScope` connection as `taskflow_app`.
 */
export function initializeSearchDatabase(config: DbConfig): void {
  if (searchPool) {
    throw new Error('Search database already initialized. This is a boot-time call.');
  }

  searchPool = new Pool({
    connectionString: config.url,
    // Small, matching every other consumer role: one relay drains one queue.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-search',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  searchDb = drizzle(searchPool);
}

/**
 * Runs `fn` as `taskflow_search` — the role that may claim outbox events
 * under consumer name 'search' across every org, and nothing else.
 *
 * NOT tenant-scoped, for the identical reason every consumer scope in this
 * file is not: one relay tick claims across every tenant, so no single value
 * of `app.org_id` is correct for it. What contains it is the role —
 * `NOBYPASSRLS`, reaching across orgs only on the tables carrying an
 * explicit `TO taskflow_search` policy.
 *
 * Throws rather than falling back to the application role — which could not
 * claim across every org anyway, so the fallback would silently drain
 * nothing while looking healthy. That refusal shape is the standing lesson
 * of Phase 4's `FOR UPDATE`-without-an-UPDATE-policy bug (migration 0016's
 * header) and every consumer scope after it.
 */
export async function withSearchScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!searchDb) {
    throw new Error(
      'Search database not initialized. Call initializeSearchDatabase() during boot — ' +
        'the indexer must not fall back to the application role, which cannot claim ' +
        'outbox events across every org and would silently index nothing.',
    );
  }

  return searchDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the search pool has been initialized. */
export function hasSearchDatabase(): boolean {
  return searchDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The automation-claim connection (ai/phase-10-automation.md §4, Phase 10
 * Wave 1, migration 0047)
 * -------------------------------------------------------------------------- */

let automationPool: pg.Pool | undefined;
let automationDb: NodePgDatabase | undefined;

/**
 * Initializes the automation engine's claim pool, as `taskflow_automation`.
 *
 * A TENTH role, and the one where the claim-only separation carries the most
 * weight. Every consumer role before it separates "find the work" from "do the
 * work" for tidiness; here the work on the other side of the line is arbitrary
 * mutation of tenant data, performed through `apps/api`'s own service layer.
 *
 * So migration 0047 gives this role the 0016 recipe — SELECT on the outbox plus
 * the UPDATE-with-`WITH CHECK (false)` policy that `FOR UPDATE` locking selects
 * require — and nothing whatsoever on `platform.automations`,
 * `automation_runs` or `automation_budget`. The role that decides WHICH events
 * might fire a rule cannot read a single rule, record a single run, or perform
 * a single action. All of that happens afterward, per event, over the ordinary
 * `withOrgScope` connection as `taskflow_app`, under RLS and `can()`.
 */
export function initializeAutomationDatabase(config: DbConfig): void {
  if (automationPool) {
    throw new Error('Automation database already initialized. This is a boot-time call.');
  }

  automationPool = new Pool({
    connectionString: config.url,
    // Small, matching every other consumer role: one relay drains one queue.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-automation',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  automationDb = drizzle(automationPool);
}

/**
 * Runs `fn` as `taskflow_automation` — the role that may claim outbox events
 * under consumer name 'automation' across every org, and nothing else.
 *
 * NOT tenant-scoped, for the identical reason every consumer scope in this file
 * is not: one tick claims across every tenant, so no single value of
 * `app.org_id` is correct for it. What contains it is the role —
 * `NOBYPASSRLS`, reaching across orgs only on the two tables carrying an
 * explicit `TO taskflow_automation` policy.
 *
 * Throws rather than falling back to the application role. The fallback would
 * be worse here than anywhere else it has been refused: `taskflow_app` cannot
 * claim across orgs, so the engine would drain nothing while looking healthy —
 * Phase 4's silent-zero-rows bug — and it CAN write every tenant table it is
 * scoped to, so a fallback would also hand the claim step privileges the design
 * spends a whole role denying it.
 */
export async function withAutomationScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!automationDb) {
    throw new Error(
      'Automation database not initialized. Call initializeAutomationDatabase() during boot — ' +
        'the engine must not fall back to the application role, which cannot claim outbox ' +
        'events across every org and would silently run nothing.',
    );
  }

  return automationDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the automation pool has been initialized. */
export function hasAutomationDatabase(): boolean {
  return automationDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The webhook-delivery claim connection (ai/phase-10-automation.md §5,
 * Wave 2, migration 0049)
 * -------------------------------------------------------------------------- */

let webhookPool: pg.Pool | undefined;
let webhookDb: NodePgDatabase | undefined;

/**
 * Initializes the webhook delivery loop's claim pool, as `taskflow_webhook`.
 *
 * An ELEVENTH role, on the same reasoning as every consumer role before it:
 * the delivery loop claims due rows across EVERY tenant in one pass, and no
 * value of `app.org_id` is correct for it.
 *
 * Migration 0049's grants are COLUMN-LEVEL and what is excluded is the point:
 * this role never sees `webhook_deliveries.payload` — the role that decides
 * what to deliver cannot read what is being delivered — and holds NOTHING on
 * `platform.webhooks`, so it cannot learn an endpoint's URL or touch its
 * signing key. The URL, the key and the payload are loaded afterward, per
 * org, over the ordinary `withOrgScope` connection as `taskflow_app`.
 */
export function initializeWebhookDatabase(config: DbConfig): void {
  if (webhookPool) {
    throw new Error('Webhook database already initialized. This is a boot-time call.');
  }

  webhookPool = new Pool({
    connectionString: config.url,
    // Small, matching every other consumer role: one loop drains one queue.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-webhook',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  webhookDb = drizzle(webhookPool);
}

/**
 * Runs `fn` as `taskflow_webhook` — the role that may claim due webhook
 * deliveries and record their outcomes, across every org, and nothing else.
 *
 * NOT tenant-scoped, for the identical reason every consumer scope in this
 * file is not: one tick claims across every tenant, so no single value of
 * `app.org_id` is correct for it. What contains it is the role —
 * `NOBYPASSRLS`, reaching across orgs only on the tables carrying an
 * explicit `TO taskflow_webhook` policy (migration 0049), through its
 * column-level grants.
 *
 * Throws rather than falling back to the application role — which cannot
 * claim across every org anyway, so the fallback would silently deliver
 * nothing while looking healthy. The standing refusal shape of this file.
 */
export async function withWebhookScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!webhookDb) {
    throw new Error(
      'Webhook database not initialized. Call initializeWebhookDatabase() during boot — ' +
        'the delivery loop must not fall back to the application role, which cannot claim ' +
        'deliveries across every org and would silently deliver nothing.',
    );
  }

  return webhookDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the webhook pool has been initialized. */
export function hasWebhookDatabase(): boolean {
  return webhookDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The integration-auth lookup connection (ai/phase-10-automation.md §7.2,
 * Phase 10 Wave 4, migration 0056)
 * -------------------------------------------------------------------------- */

let integrationAuthPool: pg.Pool | undefined;
let integrationAuthDb: NodePgDatabase | undefined;

/**
 * Initializes the inbound-connector lookup pool, as `taskflow_integration_auth`.
 *
 * The api_token_auth recipe applied to a webhook instead of a token: an
 * inbound Slack/GitHub request must be resolved to an org BEFORE any scope is
 * open — the body names a team_id / repository full_name, and the row mapping
 * that scope to an org lives on its own tenant row, so no value of
 * `app.org_id` is correct for the read.
 *
 * Migration 0056's grant is COLUMN-LEVEL and what is excluded is the point:
 * this role sees `org_id, provider, provider_scope` plus the GitHub verify
 * columns, and never `token_ciphertext`/`token_wrapped`/`token_master_id` or
 * `name` — the role that resolves "who is this webhook for" cannot read
 * anyone's outbound credential.
 */
export function initializeIntegrationAuthDatabase(config: DbConfig): void {
  if (integrationAuthPool) {
    throw new Error('Integration-auth database already initialized. This is a boot-time call.');
  }

  integrationAuthPool = new Pool({
    connectionString: config.url,
    // Small, matching every other narrow role: a lookup per inbound webhook,
    // not a workload.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-integration-auth',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  integrationAuthDb = drizzle(integrationAuthPool);
}

/**
 * Runs `fn` as `taskflow_integration_auth` — the role that may resolve an
 * inbound connector's scope to an org across every tenant, and nothing else.
 *
 * NOT tenant-scoped, for the identical reason every consumer scope in this
 * file is not: the org is unknown until the lookup answers, so no single
 * value of `app.org_id` is correct. What contains it is the role —
 * `NOBYPASSRLS`, reaching across orgs only on `platform.integrations`' one
 * `TO taskflow_integration_auth` policy, through its column-level grant.
 *
 * Throws rather than falling back to the application role — which cannot read
 * across every org anyway, so the fallback would silently refuse every
 * inbound webhook while looking healthy. The standing refusal shape of this
 * file.
 */
export async function withIntegrationAuthScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!integrationAuthDb) {
    throw new Error(
      'Integration-auth database not initialized. Call initializeIntegrationAuthDatabase() ' +
        'during boot — inbound connector verification must not fall back to the application ' +
        'role, which cannot read platform.integrations across every org and would silently ' +
        'refuse every webhook.',
    );
  }

  return integrationAuthDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the integration-auth pool has been initialized. */
export function hasIntegrationAuthDatabase(): boolean {
  return integrationAuthDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The API-token auth lookup connection (ai/phase-10-automation.md §6.2,
 * Wave 3, migration 0050)
 * -------------------------------------------------------------------------- */

let apiTokenAuthPool: pg.Pool | undefined;
let apiTokenAuthDb: NodePgDatabase | undefined;

/**
 * Initializes the API-token auth lookup pool, as `taskflow_api_token_auth`.
 *
 * A TWELFTH role, and the first one on the REQUEST hot path rather than a
 * worker loop: every token-authenticated request starts with a hash lookup,
 * and the lookup has no org yet — the token row names its org, so no value of
 * `app.org_id` is correct for it.
 *
 * Migration 0050's grant is COLUMN-LEVEL and what is excluded is the point:
 * this role sees `token_hash, org_id, created_by, scopes, revoked_at` and
 * never `name`, `token_prefix` or `last_used_at` — the role that decides who
 * you are cannot read what your tokens are called or when you last used them.
 */
export function initializeApiTokenAuthDatabase(config: DbConfig): void {
  if (apiTokenAuthPool) {
    throw new Error('API-token auth database already initialized. This is a boot-time call.');
  }

  apiTokenAuthPool = new Pool({
    connectionString: config.url,
    // Small, matching every other narrow role: a unique-index probe per
    // request, not a workload.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-api-token-auth',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  apiTokenAuthDb = drizzle(apiTokenAuthPool);
}

/**
 * Runs `fn` as `taskflow_api_token_auth` — the role that may resolve a
 * presented `tf_pat` by its hash, across every org, and nothing else.
 *
 * NOT tenant-scoped, for the identical reason every consumer scope in this
 * file is not: the org is unknown until the token row answers, so no single
 * value of `app.org_id` is correct. What contains it is the role —
 * `NOBYPASSRLS`, reaching across orgs only on `platform.api_tokens`' one
 * `TO taskflow_api_token_auth` policy, through its column-level grant.
 *
 * Throws rather than falling back to the application role — which cannot read
 * across every org anyway, so the fallback would silently refuse every token
 * while looking healthy. The standing refusal shape of this file.
 */
export async function withApiTokenAuthScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!apiTokenAuthDb) {
    throw new Error(
      'API-token auth database not initialized. Call initializeApiTokenAuthDatabase() during boot — ' +
        'token authentication must not fall back to the application role, which cannot read ' +
        'across every org and would silently refuse every token.',
    );
  }

  return apiTokenAuthDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the API-token auth pool has been initialized. */
export function hasApiTokenAuthDatabase(): boolean {
  return apiTokenAuthDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The billing-sweep connection (Phase 12 Wave 3 §3.4, migration 0056)
 * -------------------------------------------------------------------------- */

let billingSweepPool: pg.Pool | undefined;
let billingSweepDb: NodePgDatabase | undefined;

/**
 * Initializes the trial/grace-expiry sweep's pool, as `taskflow_billing_sweep`.
 *
 * A THIRTEENTH role, for the identical reason `taskflow_notification_sweep`
 * is a sixth: the sweep scans `identity.orgs` across every tenant in one
 * pass — "every trialing org whose trial has ended", "every past_due org
 * whose grace has ended" — and no value of `app.org_id` is correct for that.
 *
 * CLAIM ONLY — its grant is a column-level SELECT (`id, billing_status,
 * trial_ends_at, billing_grace_ends_at`, never `status`, Wave 1's operator
 * column) and NOTHING ELSE. The actual write happens afterward, per matched
 * org, over the ORDINARY `taskflow_app` connection inside `withOrgScope` —
 * the same "claim via a narrow cross-tenant role, act via the ordinary one"
 * split `taskflow_backlinks`/`taskflow_search`/`taskflow_automation` all
 * already use. A dedicated role rather than widening
 * `taskflow_notification_sweep`'s existing `identity.orgs` read: this
 * codebase's own standing habit is one narrow role per distinct cross-tenant
 * concern (`taskflow_recording_ingest` alongside `taskflow_backlinks`, not
 * folded into it, for the identical reason).
 */
export function initializeBillingSweepDatabase(config: DbConfig): void {
  if (billingSweepPool) {
    throw new Error('Billing-sweep database already initialized. This is a boot-time call.');
  }

  billingSweepPool = new Pool({
    connectionString: config.url,
    // Small, matching every other system role: one sweep runs per tick.
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-billing-sweep',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  billingSweepDb = drizzle(billingSweepPool);
}

/**
 * Runs `fn` as `taskflow_billing_sweep` — the role that may SCAN every
 * tenant's trial/grace deadlines. Read-only: the actual `UPDATE` on a
 * matched org happens over the ordinary `withOrgScope` connection, never
 * through this one.
 *
 * NOT tenant-scoped, for the identical reason every consumer scope in this
 * file is not: one sweep tick scans across every tenant, so no single value
 * of `app.org_id` is correct for it. What contains it is the role —
 * `NOBYPASSRLS`, reaching `identity.orgs` only through migration 0056's
 * column-level, read-only grant.
 */
export async function withBillingSweepScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!billingSweepDb) {
    throw new Error(
      'Billing-sweep database not initialized. Call initializeBillingSweepDatabase() during ' +
        'boot — the trial/grace sweep must not fall back to the application role, which cannot ' +
        'see identity.orgs across every org and would silently sweep nothing.',
    );
  }

  return billingSweepDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the billing-sweep pool has been initialized. */
export function hasBillingSweepDatabase(): boolean {
  return billingSweepDb !== undefined;
}

/* -------------------------------------------------------------------------- *
 * The operations-dashboard connection (migration 0061)
 * -------------------------------------------------------------------------- */

let opsEventsPool: pg.Pool | undefined;
let opsEventsDb: NodePgDatabase | undefined;

/**
 * Initializes the operations dashboard's writer pool, as `taskflow_ops_events`.
 *
 * A FOURTEENTH role, and a different shape from `taskflow_billing_sweep`
 * above it: not a claim-only scan, because `platform.operational_events`
 * carries no `org_id` at all — there is no tenant to scan across. Opened
 * from BOTH `apps/api` (mail delivery, billing webhooks) and `apps/worker`
 * (the sweep's own heartbeat), each with its own connection pool as this
 * same role, the same way multiple processes already share
 * `taskflow_webhook`. Reads go through `taskflow_platform_admin` instead
 * (migration 0061 grants it SELECT directly) — this pool is the write side.
 */
export function initializeOpsEventsDatabase(config: DbConfig): void {
  if (opsEventsPool) {
    throw new Error('Ops-events database already initialized. This is a boot-time call.');
  }

  opsEventsPool = new Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 2,
    application_name: config.applicationName ?? 'taskflow-ops-events',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  opsEventsDb = drizzle(opsEventsPool);
}

/**
 * Runs `fn` as `taskflow_ops_events`. Not tenant-scoped — the table this
 * role writes has no `org_id` column, so there is nothing to scope to.
 */
export async function withOpsEventScope<T>(fn: (tx: GlobalDb) => Promise<T>): Promise<T> {
  if (!opsEventsDb) {
    throw new Error(
      'Ops-events database not initialized. Call initializeOpsEventsDatabase() during boot. ' +
        "recordOperationalEvent() (packages/db/src/ops-events.ts) catches this throw itself and " +
        'reports it through its own onWriteFailure callback rather than propagating — a missing ' +
        'connection here must degrade to "no dashboard row", never to "mail delivery crashes" or ' +
        '"the webhook 500s". A caller reaching this function directly gets the throw, uncaught.',
    );
  }

  return opsEventsDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** True when the ops-events pool has been initialized. */
export function hasOpsEventsDatabase(): boolean {
  return opsEventsDb !== undefined;
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

  await backlinksPool?.end();
  backlinksPool = undefined;
  backlinksDb = undefined;

  await sweepPool?.end();
  sweepPool = undefined;
  sweepDb = undefined;

  await recordingIngestPool?.end();
  recordingIngestPool = undefined;
  recordingIngestDb = undefined;

  await platformAdminPool?.end();
  platformAdminPool = undefined;
  platformAdminDb = undefined;

  await searchPool?.end();
  searchPool = undefined;
  searchDb = undefined;

  await automationPool?.end();
  automationPool = undefined;
  automationDb = undefined;

  await webhookPool?.end();
  webhookPool = undefined;
  webhookDb = undefined;

  await apiTokenAuthPool?.end();
  apiTokenAuthPool = undefined;
  apiTokenAuthDb = undefined;

  await billingSweepPool?.end();
  billingSweepPool = undefined;
  billingSweepDb = undefined;

  await integrationAuthPool?.end();
  integrationAuthPool = undefined;
  integrationAuthDb = undefined;

  await opsEventsPool?.end();
  opsEventsPool = undefined;
  opsEventsDb = undefined;
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
