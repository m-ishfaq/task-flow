import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  withAuditScope,
  withOrgScope,
  type OrgId,
} from './client.js';
import { appendToOutbox, claimPending, markPublished, recordFailure } from './outbox.js';
import { readAuditChain, readAuditEntries } from './audit-log.js';
import { up } from './migrate/runner.js';
import type { DomainEvent } from '@taskflow/events';

/**
 * The outbox and the audit chain against real Postgres
 * (PLAN.md §8.6, §10.6, migrations 0006 & 0007).
 *
 * Three properties here cannot be demonstrated any other way, and each is one
 * that a mocked test would agree with itself about while being wrong:
 *
 *   - The outbox rejects an event stamped with another org, because RLS says
 *     so and not because the writer checked.
 *   - The audit chain is computed by a trigger, so a caller supplying its own
 *     `seq` or `hash` does not get to keep them.
 *   - taskflow_audit cannot UPDATE or DELETE an audit entry. That is a grant,
 *     and grants are only real in a database.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const ORG_A = '0195bb00-0000-7000-8000-00000000000a' as OrgId;
const ORG_B = '0195bb00-0000-7000-8000-00000000000b' as OrgId;
const ACTOR = '0195bb00-0000-7000-8000-000000000001';

const ORG_IDS = [ORG_A, ORG_B];

/** SQLSTATE for "new row violates row-level security policy". */
const RLS_VIOLATION = '42501';

function pgErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const { code } = current;
      if (typeof code === 'string') return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

let admin: pg.Client;
let idCounter = 0;

/** A well-formed envelope. The registry is not consulted — this is table access. */
function eventFor(orgId: OrgId, name = 'member.role_changed'): DomainEvent {
  idCounter += 1;
  const suffix = String(idCounter).padStart(12, '0');
  return {
    id: `0195bb00-0000-7000-8000-${suffix}`,
    name,
    version: 1,
    orgId,
    actorId: ACTOR,
    occurredAt: new Date().toISOString(),
    requestId: 'req-audit-test',
    payload: { role: 'admin' },
  } as DomainEvent;
}

async function cleanup(): Promise<void> {
  for (const orgId of ORG_IDS) {
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  }
  // audit.audit_log has no DELETE grant for anyone, by design. The migrator
  // owns the table and FORCE RLS applies, so removal happens per org scope —
  // and only here, in test teardown, never from application code.
  for (const orgId of ORG_IDS) {
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [ACTOR]);
}

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });

  admin = new pg.Client({ connectionString: MIGRATION_URL });
  await admin.connect();
  await cleanup();

  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'audit-actor@example.test', 'audit-actor@example.test', now())`,
    [ACTOR],
  );

  for (const [index, orgId] of ORG_IDS.entries()) {
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
      orgId,
      `Audit Org ${String(index)}`,
      `audit-org-${String(index)}`,
    ]);
  }

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-audit-test' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-audit-test-writer' });
});

afterAll(async () => {
  await closeDatabase();
  await cleanup();
  await admin.end();
});

beforeEach(async () => {
  for (const orgId of ORG_IDS) {
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
});

describe('outbox — writing side', () => {
  it('writes an event in the mutation’s own transaction', async () => {
    await withOrgScope(ORG_A, async (tx) => appendToOutbox(tx, [eventFor(ORG_A)]));

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT name, version FROM platform.outbox`),
    );
    expect(rows.rows).toEqual([{ name: 'member.role_changed', version: 1 }]);
  });

  it('rolls the event back with the mutation that produced it', async () => {
    /* The property the outbox exists for. A publish call placed after the
       commit would have left this event behind, describing a change that never
       happened — and nothing would report it. */
    const boom = new Error('mutation failed after emitting');

    await expect(
      withOrgScope(ORG_A, async (tx) => {
        await appendToOutbox(tx, [eventFor(ORG_A)]);
        throw boom;
      }),
    ).rejects.toThrow(boom);

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM platform.outbox`),
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
  });

  it('refuses an event stamped with another org', async () => {
    // Not checked by the writer — there is no such check to forget. The RLS
    // WITH CHECK on platform.outbox is what refuses it.
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      appendToOutbox(tx, [eventFor(ORG_B)]),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(RLS_VIOLATION);
  });

  it('keeps one org’s events invisible to another', async () => {
    await withOrgScope(ORG_A, async (tx) => appendToOutbox(tx, [eventFor(ORG_A)]));

    const rows = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM platform.outbox`),
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
  });
});

describe('outbox — draining side', () => {
  it('claims pending events across every org', async () => {
    // The relay drains one queue, not one tenant's. No value of app.org_id
    // would let it see both of these.
    await withOrgScope(ORG_A, async (tx) => appendToOutbox(tx, [eventFor(ORG_A)]));
    await withOrgScope(ORG_B, async (tx) => appendToOutbox(tx, [eventFor(ORG_B)]));

    const claimed = await withAuditScope(async (tx) => claimPending(tx));
    expect(claimed.map((row) => row.orgId).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it('does not re-claim what it has marked published', async () => {
    await withOrgScope(ORG_A, async (tx) => appendToOutbox(tx, [eventFor(ORG_A)]));

    await withAuditScope(async (tx) => {
      const claimed = await claimPending(tx);
      await markPublished(
        tx,
        claimed.map((row) => row.id),
      );
    });

    const second = await withAuditScope(async (tx) => claimPending(tx));
    expect(second).toEqual([]);
  });

  it('leaves a failed event claimable and counts the attempt', async () => {
    await withOrgScope(ORG_A, async (tx) => appendToOutbox(tx, [eventFor(ORG_A)]));

    await withAuditScope(async (tx) => {
      const [claimed] = await claimPending(tx);
      if (!claimed) throw new Error('expected a claimed event');
      await recordFailure(tx, claimed.id, 'consumer exploded');
    });

    const retry = await withAuditScope(async (tx) => claimPending(tx));
    expect(retry).toHaveLength(1);
    expect(retry[0]?.attempts).toBe(1);
  });

  it('is invisible to the application role across orgs', async () => {
    // The relay's reach comes from a policy scoped TO taskflow_audit, not from
    // BYPASSRLS. The application role must see nothing extra.
    await withOrgScope(ORG_B, async (tx) => appendToOutbox(tx, [eventFor(ORG_B)]));

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM platform.outbox`),
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
  });
});

/** Inserts an audit entry as the writer would, letting the trigger do the chain. */
async function writeEntry(orgId: OrgId, action: string): Promise<void> {
  await withAuditScope(async (tx) =>
    tx.execute(sql`
      INSERT INTO audit.audit_log (id, org_id, occurred_at, actor_id, action, hash)
      VALUES (gen_random_uuid(), ${orgId}, now(), ${ACTOR}, ${action}, '\\x00'::bytea)
    `),
  );
}

describe('reading the audit log', () => {
  it('returns occurredAt as a Date, not as the string the driver hands back', async () => {
    /**
     * `readAuditEntries` declared `occurredAt: Date` and produced it with
     * `record['occurred_at'] as Date` — a cast, not a conversion.
     *
     * The route's OUTPUT schema says `z.date()`, so every non-empty page of the
     * audit log failed output validation and answered INTERNAL_ERROR. The
     * endpoint had never worked. Nothing caught it because the service tests
     * call the service directly, where the cast is believed, and the only thing
     * that disagrees is Zod at the route boundary.
     *
     * Asserting `instanceof Date` is the whole point — a `typeof` check or a
     * comparison would both pass on the string.
     */
    await writeEntry(ORG_A, 'member.invited');

    const entries = await readAuditEntries(ORG_A, { limit: 10, before: null });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.occurredAt).toBeInstanceOf(Date);
    expect(Number.isNaN(entries[0]?.occurredAt.getTime())).toBe(false);
  });

  /**
   * TEN entries, not two, and that is the entire point of this test.
   *
   * Both readers select `seq::text AS seq`, which introduces an output column
   * named `seq` — and Postgres resolves a bare `ORDER BY seq` to that ALIAS
   * ahead of the bigint column. The rows then arrive in text order:
   * 1, 10, 11 … 2, 3 …
   *
   * Below ten entries, text and numeric order are identical and the bug cannot
   * be observed. That is why it survived: every existing test writes two or
   * three rows.
   */
  const TEN = 10;

  it('orders by sequence NUMERICALLY, not as text', async () => {
    for (let i = 0; i < TEN; i += 1) await writeEntry(ORG_A, `action.${String(i)}`);

    const entries = await readAuditEntries(ORG_A, { limit: 50, before: null });
    const sequences = entries.map((entry) => Number(entry.seq));

    // Newest first, so strictly descending.
    expect(sequences).toEqual([...sequences].sort((a, b) => b - a));
    expect(sequences[0]).toBe(TEN);
    expect(sequences[sequences.length - 1]).toBe(1);
  });

  it("resolves the actor's address for display", async () => {
    await writeEntry(ORG_A, 'member.invited');

    const entries = await readAuditEntries(ORG_A, { limit: 10, before: null });

    expect(entries[0]?.actorId).toBe(ACTOR);
    expect(entries[0]?.actorEmail).toBe('audit-actor@example.test');
  });

  /**
   * A LEFT JOIN, and this is what makes it have to be one.
   *
   * `actor_id` is null for anything the SYSTEM did — a retention sweep, a
   * scheduled automation — and §8.6 treats that as a real value rather than a
   * missing one. An INNER JOIN compiles, passes every test above, and silently
   * drops exactly those rows: the audit log would keep showing entries, would
   * never error, and would simply have no record of unattended actions.
   *
   * That is the worst shape a bug in a compliance record can take, so the empty
   * actor is asserted rather than assumed.
   */
  it('keeps entries the system wrote, which have no actor at all', async () => {
    await withAuditScope(async (tx) =>
      tx.execute(sql`
        INSERT INTO audit.audit_log (id, org_id, occurred_at, actor_id, action, hash)
        VALUES (gen_random_uuid(), ${ORG_A}, now(), NULL, 'retention.swept', '\\x00'::bytea)
      `),
    );

    const entries = await readAuditEntries(ORG_A, { limit: 10, before: null });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('retention.swept');
    expect(entries[0]?.actorId).toBeNull();
    expect(entries[0]?.actorEmail).toBeNull();
  });

  /**
   * An actor whose account is gone keeps its row AND its id.
   *
   * The id is the durable fact the entry was hashed over; only the lookup is
   * missing. A reader has to be able to tell this apart from "the system did
   * it", which is why the two nulls are separate fields rather than one
   * `actor: string | null`.
   */
  it('keeps the entry when the actor account no longer exists', async () => {
    const ghost = '0195bb00-0000-7000-8000-0000000000ff';
    await withAuditScope(async (tx) =>
      tx.execute(sql`
        INSERT INTO audit.audit_log (id, org_id, occurred_at, actor_id, action, hash)
        VALUES (gen_random_uuid(), ${ORG_A}, now(), ${ghost}, 'member.removed', '\\x00'::bytea)
      `),
    );

    const entries = await readAuditEntries(ORG_A, { limit: 10, before: null });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(ghost);
    expect(entries[0]?.actorEmail).toBeNull();
  });

  it('reads the chain in sequence order too', async () => {
    /* The reader the VERIFIER uses. Its ordering had the same alias bug, and
       there the consequence was not a scrambled page but a false tampering
       alarm — see the header comment in audit-log.ts. The end-to-end assertion
       that a healthy chain verifies intact lives in apps/api, which is where
       @taskflow/security and @taskflow/db are composed; packages/db does not
       depend on the crypto package and should not start. */
    for (let i = 0; i < TEN + 2; i += 1) await writeEntry(ORG_A, `action.${String(i)}`);

    const chain = await readAuditChain(ORG_A);
    const sequences = chain.map((row) => Number(row.seq));

    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(sequences[0]).toBe(1);
    expect(sequences[sequences.length - 1]).toBe(TEN + 2);
  });
});

describe('audit chain', () => {
  it('assigns seq and hash in the trigger, ignoring what the caller supplied', async () => {
    /* The caller passes a placeholder hash above and never a seq. If the chain
       were computed application-side, a writer could choose both — and the
       chain would then attest to whatever the writer wanted it to. */
    await writeEntry(ORG_A, 'member.invited');
    await writeEntry(ORG_A, 'member.role_changed');

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT seq::int AS seq, action, prev_hash, hash
                       FROM audit.audit_log ORDER BY seq`),
    );

    const entries = rows.rows as {
      seq: number;
      action: string;
      prev_hash: Buffer | null;
      hash: Buffer;
    }[];

    const first = entries[0];
    const second = entries[1];
    if (!first || !second) throw new Error('expected two audit entries');

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.action).toBe('member.invited');

    // The placeholder is gone: a real digest is 32 bytes.
    expect(first.hash).toHaveLength(32);

    // First entry opens the chain; the second commits to the first.
    expect(first.prev_hash).toBeNull();
    expect(second.prev_hash?.toString('hex')).toBe(first.hash.toString('hex'));
  });

  it('keeps each org on its own chain', async () => {
    // Two tenants writing concurrently must not interleave into one sequence,
    // or an org's chain would have gaps it could not distinguish from deletion.
    await writeEntry(ORG_A, 'member.invited');
    await writeEntry(ORG_B, 'member.invited');
    await writeEntry(ORG_A, 'member.removed');

    const a = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT seq::int AS seq FROM audit.audit_log ORDER BY seq`),
    );
    const b = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT seq::int AS seq FROM audit.audit_log ORDER BY seq`),
    );

    expect(a.rows).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(b.rows).toEqual([{ seq: 1 }]);
  });

  it('serializes concurrent writers into one unbroken chain', async () => {
    /* The chain-head row lock is the only thing making this a chain rather
       than a tree. Without it two concurrent inserts read the same head and
       both claim the same seq, which verification later reports as tampering
       on a table nobody touched. */
    await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) =>
        writeEntry(ORG_A, `concurrent.${String(index)}`),
      ),
    );

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT seq::int AS seq, prev_hash, hash FROM audit.audit_log ORDER BY seq`),
    );
    const entries = rows.rows as { seq: number; prev_hash: Buffer | null; hash: Buffer }[];

    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    for (let i = 1; i < entries.length; i += 1) {
      const current = entries[i];
      const previous = entries[i - 1];
      if (!current || !previous) throw new Error('expected a contiguous chain');
      expect(current.prev_hash?.toString('hex')).toBe(previous.hash.toString('hex'));
    }
  });

  it('advances the org’s chain head with every entry', async () => {
    await writeEntry(ORG_A, 'member.invited');
    await writeEntry(ORG_A, 'member.removed');

    const head = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT seq::int AS seq, hash FROM audit.chain_heads`),
    );
    const last = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT hash FROM audit.audit_log ORDER BY seq DESC LIMIT 1`),
    );

    const headRow = head.rows[0] as { seq: number; hash: Buffer } | undefined;
    const lastRow = last.rows[0] as { hash: Buffer } | undefined;
    if (!headRow || !lastRow) throw new Error('expected a chain head and a last entry');

    expect(headRow.seq).toBe(2);
    expect(headRow.hash.toString('hex')).toBe(lastRow.hash.toString('hex'));
  });
});

describe('audit log is append-only', () => {
  it('refuses an UPDATE from the writer role', async () => {
    // Grants, not application logic. taskflow_audit holds INSERT and SELECT and
    // is never granted UPDATE — so there is no role in the system that can
    // rewrite an entry, including the one that writes them.
    await writeEntry(ORG_A, 'member.invited');

    const thrown: unknown = await withAuditScope(async (tx) =>
      tx.execute(sql`UPDATE audit.audit_log SET action = 'nothing.happened'`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe('42501');
  });

  it('refuses a DELETE from the writer role', async () => {
    await writeEntry(ORG_A, 'member.invited');

    const thrown: unknown = await withAuditScope(async (tx) =>
      tx.execute(sql`DELETE FROM audit.audit_log`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe('42501');
  });

  it('refuses an INSERT from the application role', async () => {
    // The app may READ its own audit log — admins do, in the UI — and must
    // never write one. A service that could forge an entry could also forge the
    // absence of one.
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`INSERT INTO audit.audit_log (id, org_id, occurred_at, action, hash)
                     VALUES (gen_random_uuid(), ${ORG_A}, now(), 'forged', '\\x00'::bytea)`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe('42501');
  });

  it('shows an admin only their own org’s entries', async () => {
    await writeEntry(ORG_A, 'member.invited');
    await writeEntry(ORG_B, 'member.invited');

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM audit.audit_log`),
    );
    expect(rows.rows).toEqual([{ n: 1 }]);
  });
});
