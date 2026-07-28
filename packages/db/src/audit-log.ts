import { sql } from 'drizzle-orm';
import type { OrgId } from '@taskflow/contracts';
import { withAuditScope, withOrgScope, type GlobalDb } from './client.js';

/**
 * Audit log queries (PLAN.md §8.6).
 *
 * These live in packages/db rather than in the API's audit service for the
 * ordinary reason — raw SQL belongs in the data layer, and the lint rule that
 * says so is guardrail 7 — and for one specific to this table: the verification
 * SELECT list is part of the hash contract with `@taskflow/security`, so it
 * needs to sit beside the migration that defines the trigger it mirrors, not in
 * a feature module where a well-meaning edit would look harmless.
 *
 * The queries are written as raw SQL rather than through the query builder
 * because every column in `readAuditChain` needs an explicit cast to the text
 * Postgres used when hashing. A builder that renders `occurred_at` as a
 * JavaScript Date would silently lose the sub-millisecond precision the digest
 * was taken over.
 */

export interface AuditEntryRow {
  readonly id: string;
  readonly seq: string;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly changes: unknown;
  readonly requestId: string | null;
}

/**
 * A chain entry with every hashed field as the text Postgres rendered.
 *
 * Structurally identical to `StoredAuditEntry` in @taskflow/security, and
 * deliberately declared here rather than imported: the data layer has no
 * business depending on the crypto package to describe its own rows, and
 * structural typing means the verifier accepts these without a cast.
 */
export interface AuditChainRow {
  readonly id: string;
  readonly orgId: string;
  readonly seq: string;
  readonly occurredAtMs: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly changes: string | null;
  readonly decision: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly sessionId: string | null;
  readonly requestId: string | null;
  readonly prevHash: Buffer | null;
  readonly hash: Buffer;
}

/** Narrows an unknown column to text, without stringifying an object into it. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function required(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface ReadAuditInput {
  readonly limit: number;
  /** Return entries strictly older than this `seq`. Null starts at the newest. */
  readonly before: string | null;
}

/**
 * The org's entries, newest first.
 *
 * Keyset pagination on `seq` rather than OFFSET. An append-only log grows while
 * it is being read, so an OFFSET page silently repeats rows as new entries push
 * older ones down — which reads as duplicated events rather than as a paging
 * artefact.
 */
export async function readAuditEntries(
  orgId: OrgId,
  input: ReadAuditInput,
): Promise<readonly AuditEntryRow[]> {
  return withOrgScope(orgId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT id::text          AS id,
             seq::text         AS seq,
             occurred_at       AS occurred_at,
             actor_id::text    AS actor_id,
             action            AS action,
             resource_type     AS resource_type,
             resource_id::text AS resource_id,
             changes           AS changes,
             request_id        AS request_id
        FROM audit.audit_log
       WHERE (${input.before}::bigint IS NULL OR seq < ${input.before}::bigint)
       ORDER BY seq DESC
       LIMIT ${input.limit}
    `);

    return result.rows.map((row): AuditEntryRow => {
      const record: Record<string, unknown> = row;
      return {
        id: required(record['id']),
        seq: required(record['seq']),
        occurredAt: record['occurred_at'] as Date,
        actorId: text(record['actor_id']),
        action: required(record['action']),
        resourceType: text(record['resource_type']),
        resourceId: text(record['resource_id']),
        changes: record['changes'],
        requestId: text(record['request_id']),
      };
    });
  });
}

/**
 * The org's whole chain, in `seq` order, cast for verification.
 *
 * THE SELECT LIST IS PART OF THE HASH CONTRACT. Each cast reproduces the text
 * the trigger hashed (migration 0007):
 *
 *   - `changes::text` / `decision::text` — jsonb has its own rendering, with
 *     its own key ordering and escaping. Re-serializing a parsed object in
 *     JavaScript would be a second implementation of Postgres, guaranteed to
 *     drift.
 *   - `occurred_at` as epoch MILLISECONDS — every textual rendering of a
 *     timestamptz depends on the session's TimeZone and DateStyle, so a
 *     verifier connecting with different settings would report tampering on
 *     rows nobody touched.
 */
export async function readAuditChain(orgId: OrgId): Promise<readonly AuditChainRow[]> {
  return withOrgScope(orgId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT id::text            AS id,
             org_id::text        AS org_id,
             seq::text           AS seq,
             (extract(epoch FROM occurred_at) * 1000)::bigint::text AS occurred_at_ms,
             actor_id::text      AS actor_id,
             action              AS action,
             resource_type       AS resource_type,
             resource_id::text   AS resource_id,
             changes::text       AS changes,
             decision::text      AS decision,
             ip::text            AS ip,
             user_agent          AS user_agent,
             session_id::text    AS session_id,
             request_id          AS request_id,
             prev_hash           AS prev_hash,
             hash                AS hash
        FROM audit.audit_log
       ORDER BY seq
    `);

    return result.rows.map((row): AuditChainRow => {
      const record: Record<string, unknown> = row;
      return {
        id: required(record['id']),
        orgId: required(record['org_id']),
        seq: required(record['seq']),
        occurredAtMs: required(record['occurred_at_ms']),
        actorId: text(record['actor_id']),
        action: required(record['action']),
        resourceType: text(record['resource_type']),
        resourceId: text(record['resource_id']),
        changes: text(record['changes']),
        decision: text(record['decision']),
        ip: text(record['ip']),
        userAgent: text(record['user_agent']),
        sessionId: text(record['session_id']),
        requestId: text(record['request_id']),
        prevHash: (record['prev_hash'] as Buffer | null) ?? null,
        hash: record['hash'] as Buffer,
      };
    });
  });
}

/** What the projection supplies. `seq`, `prevHash` and `hash` are the trigger's. */
export interface NewAuditEntry {
  readonly id: string;
  readonly orgId: string;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly changes: unknown;
  readonly requestId: string | null;
}

/**
 * Appends one entry, as `taskflow_audit`, inside the caller's transaction.
 *
 * Takes the transaction rather than opening its own, so the projection can
 * claim outbox rows, write their entries, and mark them published atomically —
 * which is what makes the audit projection exactly-once rather than
 * at-least-once.
 *
 * `hash` is supplied as an empty placeholder because the column is NOT NULL and
 * the trigger overwrites it. Letting a caller pass a real digest is precisely
 * what the trigger exists to prevent.
 */
export async function insertAuditEntry(tx: GlobalDb, entry: NewAuditEntry): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit.audit_log
      (id, org_id, occurred_at, actor_id, action, resource_type, resource_id,
       changes, request_id, hash)
    VALUES (
      ${entry.id}::uuid,
      ${entry.orgId}::uuid,
      ${entry.occurredAt.toISOString()}::timestamptz,
      ${entry.actorId}::uuid,
      ${entry.action},
      ${entry.resourceType},
      ${entry.resourceId}::uuid,
      ${JSON.stringify(entry.changes)}::jsonb,
      ${entry.requestId},
      ''::bytea
    )
  `);
}

/** Convenience for callers that want one entry in its own transaction. */
export async function appendAuditEntry(entry: NewAuditEntry): Promise<void> {
  await withAuditScope(async (tx) => insertAuditEntry(tx, entry));
}
