import { sql } from 'drizzle-orm';
import type { GlobalDb } from './client.js';
import { withPlatformAdminScope } from './client.js';

/**
 * The operator audit chain — reading and writing (Phase 12 §4, migration
 * 0032).
 *
 * Lives here rather than in `apps/api/src/platform-admin`, for the identical
 * reason `audit-log.ts` lives here rather than in the tenancy module: raw SQL
 * is banned outside `packages/db` (guardrail 7), and the verification reader
 * needs an explicit cast on every hashed column to the exact text Postgres
 * used when hashing — a Drizzle-typed read would silently lose that. See
 * `audit-log.ts`'s own header for the fuller argument; this file is the
 * identical shape applied to a second, smaller chain.
 */

/** Converts a timestamp column into a `Date`. See `audit-log.ts`'s `instant()` for why this exists. */
function instant(value: unknown): Date {
  if (value instanceof Date) return value;

  if (typeof value !== 'string') {
    throw new TypeError(
      `Expected a timestamp from platform.operator_audit_log, received ${typeof value}.`,
    );
  }

  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(normalized);

  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Could not parse the operator-audit timestamp ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function required(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface OperatorAuditEntryRow {
  readonly seq: string;
  readonly operatorId: string;
  readonly action: string;
  readonly target: unknown;
  readonly occurredAt: Date;
}

export interface ReadOperatorAuditInput {
  readonly limit: number;
  /** Return entries strictly older than this `seq`. Null starts at the newest. */
  readonly before: string | null;
}

/**
 * The operator log's entries, newest first — the Audit tab's own read
 * (§3.10). Keyset-paginated on `seq`, the identical reasoning
 * `readAuditEntries` documents: an append-only log grows while it is being
 * read, so an OFFSET page would repeat rows.
 */
export async function readOperatorAuditEntries(
  input: ReadOperatorAuditInput,
): Promise<readonly OperatorAuditEntryRow[]> {
  return withPlatformAdminScope(async (tx) => {
    const result = await tx.execute(sql`
      SELECT seq::text         AS seq,
             operator_id::text AS operator_id,
             action            AS action,
             target            AS target,
             occurred_at       AS occurred_at
        FROM platform.operator_audit_log
       WHERE (${input.before}::bigint IS NULL OR seq < ${input.before}::bigint)
       ORDER BY seq DESC
       LIMIT ${input.limit}
    `);

    return result.rows.map((row): OperatorAuditEntryRow => {
      const record: Record<string, unknown> = row;
      return {
        seq: required(record['seq']),
        operatorId: required(record['operator_id']),
        action: required(record['action']),
        target: record['target'],
        occurredAt: instant(record['occurred_at']),
      };
    });
  });
}

/**
 * A chain entry with every hashed field as the text Postgres rendered.
 *
 * Structurally identical to `OperatorChainEntry` in `@taskflow/security`,
 * and deliberately declared here rather than imported: the data layer has
 * no business depending on the crypto package to describe its own rows —
 * the same reasoning `AuditChainRow` already documents.
 */
export interface OperatorChainRow {
  readonly seq: string;
  readonly occurredAtMs: string;
  readonly operatorId: string;
  readonly action: string;
  readonly target: string | null;
  readonly prevHash: Buffer | null;
  readonly hash: Buffer;
}

/** The whole chain, in order — what the verifier walks. */
export async function readOperatorChain(): Promise<readonly OperatorChainRow[]> {
  return withPlatformAdminScope(async (tx) => {
    const result = await tx.execute(sql`
      SELECT seq::text                                              AS seq,
             (extract(epoch FROM occurred_at) * 1000)::bigint::text AS occurred_at_ms,
             operator_id::text                                      AS operator_id,
             action                                                 AS action,
             target::text                                           AS target,
             prev_hash                                              AS prev_hash,
             hash                                                   AS hash
        FROM platform.operator_audit_log
       ORDER BY seq
    `);

    return result.rows.map((row): OperatorChainRow => {
      const record: Record<string, unknown> = row;
      return {
        seq: required(record['seq']),
        occurredAtMs: required(record['occurred_at_ms']),
        operatorId: required(record['operator_id']),
        action: required(record['action']),
        target: typeof record['target'] === 'string' ? record['target'] : null,
        prevHash: (record['prev_hash'] as Buffer | null) ?? null,
        hash: record['hash'] as Buffer,
      };
    });
  });
}

/** What a caller supplies. `seq`, `prevHash` and `hash` are the trigger's. */
export interface NewOperatorAuditEntry {
  readonly operatorId: string;
  /** e.g. `'orgs.suspend'`, `'orgs.list'` — a short, stable string, never user input. */
  readonly action: string;
  /** `{ orgId }` or `{ userId }`, or null for a bare list call with no single resource named. */
  readonly target: Record<string, unknown> | null;
}

/**
 * Appends one entry, as `taskflow_platform_admin`, inside the caller's
 * transaction.
 *
 * Takes the transaction rather than opening its own, so a `platformAdmin.*`
 * handler can write its org-scoped audit entry (via `withAuditScope`,
 * `apps/api/src/tenancy`'s existing mechanism) and its operator-log entry
 * together — see `apps/api/src/platform-admin`'s router for how "every call
 * is audited" is made structural rather than remembered per-route.
 *
 * `hash` is supplied as an empty placeholder because the column is NOT NULL
 * and the trigger overwrites it — the identical reasoning
 * `insertAuditEntry` documents for `audit.audit_log`.
 */
export async function insertOperatorAuditEntry(
  tx: GlobalDb,
  entry: NewOperatorAuditEntry,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO platform.operator_audit_log (operator_id, action, target, hash)
    VALUES (
      ${entry.operatorId}::uuid,
      ${entry.action},
      ${entry.target === null ? null : JSON.stringify(entry.target)}::jsonb,
      ''::bytea
    )
  `);
}

/** Convenience for a caller that wants one entry in its own transaction. */
export async function appendOperatorAuditEntry(entry: NewOperatorAuditEntry): Promise<void> {
  await withPlatformAdminScope(async (tx) => insertOperatorAuditEntry(tx, entry));
}
