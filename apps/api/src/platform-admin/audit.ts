import { desc, eq, lt, schema, withPlatformAdminScope } from '@taskflow/db';
import type { UserId } from '@taskflow/contracts';

/**
 * The global operator audit log — the wave's accountability record
 * (ai/phase-12-admin.md §4, decision 2 option (c)).
 *
 * `platform.operator_audit_log` is a hash chain under one global lock, exactly
 * like `audit.audit_log` is under per-org locks: `seq`, `prev_hash` and `hash`
 * are assigned by the BEFORE INSERT trigger (migration 0035), never by the
 * caller, so a writer cannot choose its own position or digest. Every insert
 * here goes through `withPlatformAdminScope`, the one role granted INSERT.
 *
 * ## Why a shared helper, and why every route calls it
 *
 * §5's acceptance criterion is that EVERY `platformAdmin.*` call — including
 * the read-only list routes — produces a row here. Centralizing the write in
 * one function is what makes that a property of the module instead of a
 * per-route intention; an operator's accountability record should not depend
 * on which orgs happen to still exist to attribute a read to.
 */

/**
 * Records one operator action in the global chain.
 *
 * `target` is `{ orgId }` or `{ userId }` for a targeted action, or null for
 * a bare list call. NOT transactional with the org-scoped write it reports:
 * the action runs as `taskflow_platform_admin` and the write it reports may
 * run on a different connection pool entirely (`withOrgScope`), so this is
 * the one place in this wave where atomicity between an action and its audit
 * row is honestly unachievable — a failure here is a missing log row, never
 * a wrong one, and the row is the record of an action that did happen.
 */
export async function recordOperatorAction(
  operatorId: UserId,
  action: string,
  target: Record<string, unknown> | null,
): Promise<void> {
  await withPlatformAdminScope(async (tx) => {
    await tx.insert(schema.operatorAuditLog).values({
      operatorId,
      action,
      target,
      /* `seq` and `hash` are the trigger's, never the caller's — the same
         placeholder discipline `insertAuditEntry` applies to audit.audit_log:
         the columns are NOT NULL and the BEFORE INSERT trigger overwrites
         them, so the insert names the fact (operator, action, target) and
         cannot choose its own position or digest. */
      seq: 0,
      hash: Buffer.alloc(0),
    });
  });
}

export interface OperatorAuditEntry {
  readonly seq: string;
  readonly operatorId: string;
  readonly operatorEmail: string;
  readonly action: string;
  readonly target: unknown;
  readonly occurredAt: Date;
  /** Hex-encoded `hash` — the chain link itself, per this table's own
      trigger. Exposed read-only so the console can show that every row is
      cryptographically linked, not merely claim it in prose (Design Bible
      §18's own "Chain" column). Never used to VERIFY anything client-side —
      the trigger and a real verifier are what prove the chain, this is
      only a visible reminder that one exists. */
  readonly hash: string;
}

/**
 * The operator chain, newest first — the Audit tab's feed.
 *
 * Keyset pagination on `seq` (an append-only log grows while it is being
 * read; OFFSET would silently repeat rows). The operator's address is joined
 * at read time, never stored on the hashed entry — the identical reason
 * `readAuditEntries` gives for `audit.audit_log`: the id is the durable fact
 * the digest committed to, and the address is a mutable attribute of the
 * account that can change afterwards.
 */
export async function readOperatorAudit(input: {
  readonly limit: number;
  /** Return entries strictly older than this `seq`. Null starts at the newest. */
  readonly before: string | null;
}): Promise<readonly OperatorAuditEntry[]> {
  return withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select({
        seq: schema.operatorAuditLog.seq,
        operatorId: schema.operatorAuditLog.operatorId,
        operatorEmail: schema.users.email,
        action: schema.operatorAuditLog.action,
        target: schema.operatorAuditLog.target,
        occurredAt: schema.operatorAuditLog.occurredAt,
        hash: schema.operatorAuditLog.hash,
      })
      .from(schema.operatorAuditLog)
      .innerJoin(schema.users, eq(schema.users.id, schema.operatorAuditLog.operatorId))
      .where(
        input.before === null ? undefined : lt(schema.operatorAuditLog.seq, Number(input.before)),
      )
      .orderBy(desc(schema.operatorAuditLog.seq))
      .limit(input.limit);

    return rows.map((row) => ({
      seq: String(row.seq),
      operatorId: row.operatorId,
      operatorEmail: row.operatorEmail,
      action: row.action,
      target: row.target,
      occurredAt: row.occurredAt,
      hash: Buffer.from(row.hash).toString('hex'),
    }));
  });
}
