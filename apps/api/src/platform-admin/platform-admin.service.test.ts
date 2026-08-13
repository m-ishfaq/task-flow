import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
  readAuditEntries,
  schema,
  withGlobalScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { SoftwareKeyProvider } from '@taskflow/security';
import { FakeTelephonyProvider } from '@taskflow/telephony';
import { createCallerFactory } from '../trpc/builder.js';
import { TEST_ENV, testContext, testPrincipal } from '../testing/fixtures.js';
import * as members from '../tenancy/member.service.js';
import * as orgs from '../tenancy/org.service.js';
import { resolveOrgMembership } from '../tenancy/resolve.js';
import { loadSubaccount } from '../telephony/subaccount.service.js';
import { readOperatorAudit } from './audit.js';
import { listFlags, setFlag } from './flags.service.js';
import * as directory from './org-directory.service.js';
import type { PlatformOperator } from './org-directory.service.js';
import { isPlatformOperator } from './operator.js';
import { createPlatformAdminRouter } from './router.js';
import { FakePaymentProvider } from '@taskflow/payments';

/**
 * The platform-admin slice (ai/phase-12-admin.md §6), against real Postgres.
 *
 * These are the tests §6 names explicitly, and each exists because a weaker
 * version would have passed:
 *
 *   - `isPlatformOperator` false for an ordinary user — the one-line assertion
 *     that catches an accidental default-allow.
 *   - `taskflow_app` CANNOT INSERT into platform.operators — a GRANT-LEVEL
 *     assertion connected as the application role, expecting Postgres to refuse
 *     it. §3.1 is explicit that this is the one control with no code-level
 *     fallback if the grant is ever widened.
 *   - `directory.listOrgs` returns real rows THROUGH withPlatformAdminScope —
 *     the §3.7 class of bug that passes a type check and a superficial review
 *     (a `withGlobalScope` read of identity.orgs would silently return []).
 *   - Every route answers FORBIDDEN for an ordinary org member — not a 404,
 *     not a pass-through.
 *
 * The operator chain (platform.operator_audit_log) is a GLOBAL hash chain, so
 * beforeEach resets it and the singleton head — the same reason the tenancy
 * suites reset their per-org fixtures. Assertions therefore never depend on
 * absolute sequence numbers.
 */
const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';

const OPERATOR = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000a1');
const ORDINARY = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000a2');
const OWNER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000a3');
const COLLEAGUE = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000a4');

const USERS: readonly [UserId, string][] = [
  [OPERATOR, 'operator@platform.test'],
  [ORDINARY, 'ordinary@platform.test'],
  [OWNER, 'owner@platform.test'],
  [COLLEAGUE, 'colleague@platform.test'],
];

/**
 * Walks the `cause` chain for the wrapped error's message.
 *
 * Drizzle wraps driver errors (`Failed query: ...` with the pg error on
 * `cause`), and how deeply they wrap changes between versions — the identical
 * reasoning `client.test.ts`'s `pgErrorCode` documents, except that helper
 * keys on the SQLSTATE while this one reads the message text. Reading through
 * the chain instead of `expect.objectContaining` also keeps this suite free
 * of the `any` those vitest matchers return (`no-unsafe-assignment`).
 */
function causeMessage(error: unknown): string | undefined {
  /* Walks to the DEEPEST message, not the first: every level of the chain
     carries one — the wrapper's own `Failed query: ...` first — and the
     pg error the assertion cares about is at the bottom. The same reason
     client.test.ts's `pgErrorCode` keys on the SQLSTATE: only the
     innermost level has it. */
  let current = error;
  let found: string | undefined;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'message' in current) {
      const { message } = current;
      if (typeof message === 'string') found = message;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

const requestId = unsafeAsId<'RequestId'>('0195dd00-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});
const operatorOf = (userId: UserId): PlatformOperator => ({ userId, requestId });

/* The §9 freeze path never touches the key provider (setSubaccountStatus
   reads the subaccount row and calls the carrier), but SubaccountDeps
   requires one — a real provider is cheaper than a cast. */
const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: [{ id: MASTER_KEY_ID, key: new Uint8Array(32).fill(7) }],
});

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Platform ${slug}`, slug }, actorOf(OWNER));
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  /* §9 freeze tests provision a carrier subaccount; children before parents. */
  await admin.query(`DELETE FROM comms.subaccount_orgs WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.subaccounts WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.team_members WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.teams WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-platform-svc' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-platform-audit' });
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-platform-admin',
  });
});

/* Torn down before each test rather than after, so a failing test leaves its
   rows in the database to inspect. The operator chain and the singleton head
   are reset here too — it is global, and a test that started mid-chain could
   not tell its own entries from its predecessor's. */
beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];

  await admin.setOrg(null);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(
    `UPDATE platform.operator_chain_head SET seq = 0, hash = '\\x'::bytea WHERE id = true`,
  );
  await admin.query(`DELETE FROM platform.flag_overrides`);
  await admin.query(`DELETE FROM platform.operators`);
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);

  await admin.setOrg(null);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(`DELETE FROM platform.flag_overrides`);
  await admin.query(`DELETE FROM platform.operators`);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

describe('the operator flag', () => {
  it('answers false for an ordinary user by default', async () => {
    // The one-line assertion that catches an accidental default-allow: if the
    // check ever inverted, every authenticated user would be an operator.
    expect(await isPlatformOperator(ORDINARY)).toBe(false);
  });

  it('answers true once the migrator grants the flag', async () => {
    await admin.setOrg(null);
    await admin.query(
      `INSERT INTO platform.operators (user_id, granted_by, note)
       VALUES ($1, $1, 'test grant')`,
      [OPERATOR],
    );

    expect(await isPlatformOperator(OPERATOR)).toBe(true);
  });
});

describe('the operator table is write-proof at the grant level', () => {
  it('refuses an INSERT by the application role', async () => {
    /* §3.1's "the one control with no code-level fallback": the grant is the
       entire mechanism, so the assertion must fail against a widened grant.
       Connected as taskflow_app (withGlobalScope uses the application pool),
       Postgres refuses before any application code could. */
    /* Caught and walked rather than `rejects.toMatchObject({ cause: ... })`:
       Drizzle wraps the Postgres error (`Failed query: ...` with the pg
       error as `cause`), so the assertion must read through to the cause, and
       the vitest matchers that nested the check return `any`. `causeMessage`
       below is the typed way to say the same thing — the same walk
       client.test.ts performs for the SQLSTATE. */
    const thrown: unknown = await withGlobalScope(async (tx) => {
      await tx.insert(schema.operators).values({
        userId: ORDINARY,
        grantedBy: ORDINARY,
        note: 'attempted escalation',
      });
    }).catch((error: unknown) => error);

    expect(causeMessage(thrown)).toMatch(/permission denied/i);
  });
});

describe('the org directory', () => {
  it('returns real rows through the taskflow_platform_admin connection', async () => {
    /* The §3.7 class of bug: a withGlobalScope read of identity.orgs (FORCE
       RLS keyed on app.org_id) silently returns [] and a smoke test misreads
       that as "no orgs exist yet". Only the dedicated role's permissive
       policies — which this service is the one path to — make it mean
       anything. Asserting CONTENT rather than a length proves it went through
       the real role. */
    const first = await newOrg('dir-one');
    await newOrg('dir-two');

    const result = await directory.listOrgs(operatorOf(OPERATOR), { cursor: null, limit: 10 });

    const mine = result.orgs.find((row) => row.orgId === first);
    expect(mine).toBeDefined();
    expect(mine?.name).toBe('Platform dir-one');
    expect(mine?.status).toBe('active');
    expect(mine?.memberCount).toBe(1);
  });

  it('suspends an org, and the enforcement follows for every member', async () => {
    const orgId = await newOrg('suspend-one');
    /* COLLEAGUE must be an actual member for the suspension check to be what
       is asserted: a non-member would (correctly) resolve to null —
       NOT_A_MEMBER — before the org-status check ever runs, which tests the
       membership path, not the suspension. */
    await members.addMember(
      orgId,
      { email: 'colleague@platform.test', role: 'member' },
      actorOf(OWNER),
    );
    const events = new RecordingEventBus();

    await directory.suspendOrg({ events }, operatorOf(OPERATOR), orgId);

    /* The enforcement lives in resolveOrgMembership — the function every
       org-scoped route, realtime room join, and collab page authorization runs
       through. One change here refuses all three for free. */
    await expect(resolveOrgMembership(OWNER, orgId)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });
    await expect(resolveOrgMembership(COLLEAGUE, orgId)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });

    /* Both audit destinations, per §4 decision 2 option (c). */
    const operatorEntries = await readOperatorAudit({ limit: 50, before: null });
    expect(
      operatorEntries.some(
        (entry) => entry.action === 'orgs.suspend' && entry.operatorId === OPERATOR,
      ),
    ).toBe(true);

    const orgEntries = await readAuditEntries(orgId, { limit: 50, before: null });
    expect(
      orgEntries.some(
        (entry) => entry.action === 'platform.org_suspended' && entry.actorId === OPERATOR,
      ),
    ).toBe(true);

    /* Reactivation reverses the state, and the membership reads again. */
    await directory.reactivateOrg({ events }, operatorOf(OPERATOR), orgId);
    expect((await resolveOrgMembership(OWNER, orgId))?.role).toBe('owner');
  });
});

describe('the operator console routes', () => {
  it('answers FORBIDDEN for an ordinary org member, not a 404 and not a pass-through', async () => {
    /* The guardrail-8 mirror case: platform routes take no org context to
       substitute a foreign id into, so ordinary tenancy fuzzing cannot cover
       them. An ordinary member — any role — reaching any of them must get the
       honest denial shape. */
    const context = testContext({ principal: testPrincipal('member') });
    const caller = createCallerFactory(
      createPlatformAdminRouter({
        events: new RecordingEventBus(),
        payments: new FakePaymentProvider(),
      }),
    )(context);

    const error = await caller.orgs
      .list({ cursor: null, limit: 10 })
      .catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('FORBIDDEN');
  });

  it('lets self.check answer for everyone, operator or not', async () => {
    /* §3.2's exception, and its whole point: the account menu needs to know
       whether to render a /platform-admin link, which means every logged-in
       user calls this on every load — so it must NOT be a platformRoute. */
    const context = testContext({ principal: testPrincipal('member') });
    const caller = createCallerFactory(
      createPlatformAdminRouter({
        events: new RecordingEventBus(),
        payments: new FakePaymentProvider(),
      }),
    )(context);

    expect(await caller.self.check()).toEqual({ isOperator: false });
  });
});

describe('feature-flag overrides', () => {
  it('lists every registry flag at its default', async () => {
    const rows = await listFlags(operatorOf(OPERATOR));
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.source).toBe('default');
      expect(row.value).toBe(row.defaultValue);
    }
  });

  it('persists a global override and clears it back to the default', async () => {
    const events = new RecordingEventBus();

    await setFlag({ events }, operatorOf(OPERATOR), { flagName: 'chat', value: true });

    const overridden = await listFlags(operatorOf(OPERATOR));
    const chat = overridden.find((row) => row.flagName === 'chat');
    expect(chat?.value).toBe(true);
    expect(chat?.source).toBe('override');

    await setFlag({ events }, operatorOf(OPERATOR), { flagName: 'chat', value: null });

    const cleared = await listFlags(operatorOf(OPERATOR));
    expect(cleared.find((row) => row.flagName === 'chat')?.source).toBe('default');
  });
});

describe('the operator chain', () => {
  it('assigns a global sequence, newest first', async () => {
    const orgId = await newOrg('chain-one');
    const events = new RecordingEventBus();

    await directory.listOrgs(operatorOf(OPERATOR), { cursor: null, limit: 5 });
    await directory.suspendOrg({ events }, operatorOf(OPERATOR), orgId);
    await setFlag({ events }, operatorOf(OPERATOR), { flagName: 'chat', value: true });

    const entries = await readOperatorAudit({ limit: 50, before: null });
    expect(entries.length).toBeGreaterThanOrEqual(3);

    /* Newest first, one shared global counter. The three actions THIS test
       performed are the three most recent in the freshly-reset chain. */
    const seqs = entries.map((entry) => Number(entry.seq));
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i - 1] ?? 0).toBeGreaterThan(seqs[i] ?? 0);
    }
    expect(entries.slice(0, 3).map((entry) => entry.action)).toEqual([
      'flags.set',
      'orgs.suspend',
      'orgs.list',
    ]);
  });
});

describe('the §9 carrier subaccount freeze (ai/phase-12-admin.md §9)', () => {
  /* Seeds a subaccount row the way ensureSubaccount would have, with a
     FIXED SID that the fake provider can never generate (its SIDs are
     'AC' + 32 digits starting at 1). The two suites share taskflow_test and
     both use the same fake, whose per-instance counter starts over at 1 — a
     test that provisioned through ensureSubaccount here would collide with
     subaccount.service.test.ts's rows on `subaccounts_sid_key` (the same
     foreign-fixture trap relay.test.ts's `ours()` documents). The ciphertext
     columns are dummy bytes: the freeze path never decrypts. */
  async function seedSubaccount(
    orgId: OrgId,
    provider: FakeTelephonyProvider,
    sid: string,
  ): Promise<void> {
    provider.subaccounts.set(sid, { status: 'active', friendlyName: 'freeze-fixture' });
    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO comms.subaccounts
         (org_id, provider, subaccount_sid, auth_token_ciphertext, data_key_wrapped,
          data_key_master_id, status)
       VALUES ($1, 'twilio', $2, '\\x00'::bytea, '\\x00'::bytea, 'test-master', 'active')`,
      [orgId, sid],
    );
    await admin.query(
      `INSERT INTO comms.subaccount_orgs (subaccount_sid, org_id) VALUES ($1, $2)`,
      [sid, orgId],
    );
    await admin.setOrg(null);
  }

  it('suspending an org freezes its carrier subaccount; reactivating restores it', async () => {
    const orgId = await newOrg('freeze-one');
    const provider = new FakeTelephonyProvider();
    const SID = 'ACffffffffffffffffffffffffffffffff';
    await seedSubaccount(orgId, provider, SID);

    await directory.suspendOrg(
      { events: new RecordingEventBus(), subaccounts: { telephony: provider, keys } },
      operatorOf(OPERATOR),
      orgId,
    );

    /* The freeze must reach the CARRIER, not just our local record: refusing
       outbound calls in checkOutboundAllowed does nothing about a leaked
       credential used directly against Twilio, which answers to whoever
       holds the token. Asserting the fake's own state is the proof the
       provider was reached. */
    expect(provider.subaccounts.get(SID)?.status).toBe('suspended');
    expect((await loadSubaccount(orgId))?.status).toBe('suspended');

    await directory.reactivateOrg(
      { events: new RecordingEventBus(), subaccounts: { telephony: provider, keys } },
      operatorOf(OPERATOR),
      orgId,
    );

    expect(provider.subaccounts.get(SID)?.status).toBe('active');
    expect((await loadSubaccount(orgId))?.status).toBe('active');
  });

  it('suspends cleanly when the org has no carrier subaccount', async () => {
    const orgId = await newOrg('freeze-none');
    const provider = new FakeTelephonyProvider();

    /* Most orgs never provision telephony — NOT_FOUND from the freeze must
       be swallowed, never fail the suspension. */
    await directory.suspendOrg(
      { events: new RecordingEventBus(), subaccounts: { telephony: provider, keys } },
      operatorOf(OPERATOR),
      orgId,
    );

    await expect(resolveOrgMembership(OWNER, orgId)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });
  });

  it('suspends cleanly when no carrier is configured at all', async () => {
    const orgId = await newOrg('freeze-nocarrier');

    await directory.suspendOrg({ events: new RecordingEventBus() }, operatorOf(OPERATOR), orgId);

    await expect(resolveOrgMembership(OWNER, orgId)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });
  });
});

describe('org deletion (Phase 12 Wave 2 §3.5)', () => {
  it('refuses to delete an org that is not suspended', async () => {
    /* Deletion is a two-step operation — suspend, THEN delete. The gate is
       the first assertion a weaker implementation would skip (checking the
       slug only would let a one-click mistake erase a live org). */
    const orgId = await newOrg('delete-active');

    const error: unknown = await directory
      .deleteOrg({ events: new RecordingEventBus() }, operatorOf(OPERATOR), {
        orgId,
        confirmSlug: 'delete-active',
      })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('VALIDATION_FAILED');

    /* The org survives — nothing was deleted. */
    const after = await directory.listOrgs(operatorOf(OPERATOR), { cursor: null, limit: 10 });
    expect(after.orgs.some((row) => row.orgId === orgId)).toBe(true);
  });

  it('refuses to delete a suspended org when the confirmation slug does not match', async () => {
    const orgId = await newOrg('delete-wrongslug');
    await directory.suspendOrg({ events: new RecordingEventBus() }, operatorOf(OPERATOR), orgId);

    const error: unknown = await directory
      .deleteOrg({ events: new RecordingEventBus() }, operatorOf(OPERATOR), {
        orgId,
        confirmSlug: 'not-the-slug',
      })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('VALIDATION_FAILED');

    /* Still suspended, still there — the wrong slug must not consume the org. */
    const after = await directory.listOrgs(operatorOf(OPERATOR), { cursor: null, limit: 10 });
    expect(after.orgs.find((row) => row.orgId === orgId)?.status).toBe('suspended');
  });

  it('deletes the org, its audit chain, and rows across Work, Chat, Docs, People and outbox', async () => {
    const orgId = await newOrg('delete-cascade');
    const events = new RecordingEventBus();

    /* A suspension writes a REAL entry into the org's audit chain. That entry
       must be purged with the org (migration 0044) — not left behind as rows
       in a chain nobody can ever query again (the org row is gone, so every
       org-scoped RLS policy matches nothing). The assertion below that
       audit.audit_log is empty is what proves the trigger, not a cascade. */
    await directory.suspendOrg({ events }, operatorOf(OPERATOR), orgId);

    /* One seeded row per product schema + the outbox, each keyed on org_id
       with a cascading FK — the §6 test that would catch a foreign key that
       never got ON DELETE CASCADE (the migration audit says every one
       cascades; this is the proof against a real database). */
    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, 'Doomed', 'DOOM')`,
      ['0195dd00-0000-7000-8000-0000000000d1', orgId],
    );
    await admin.query(
      `INSERT INTO chat.channels (id, org_id, type, name) VALUES ($1, $2, 'public', 'general')`,
      ['0195dd00-0000-7000-8000-0000000000d2', orgId],
    );
    await admin.query(
      `INSERT INTO docs.spaces (id, org_id, name) VALUES ($1, $2, 'Doomed space')`,
      ['0195dd00-0000-7000-8000-0000000000d3', orgId],
    );
    await admin.query(
      `INSERT INTO people.membership_profiles (org_id, user_id, job_title) VALUES ($1, $2, 'doomed')`,
      [orgId, OWNER],
    );
    await admin.query(
      `INSERT INTO platform.outbox (id, org_id, name, version, occurred_at, payload)
       VALUES ($1, $2, 'test.org_deleted_probe', 1, now(), '{}'::jsonb)`,
      ['0195dd00-0000-7000-8000-0000000000d4', orgId],
    );
    await admin.setOrg(null);

    const result = await directory.deleteOrg({ events }, operatorOf(OPERATOR), {
      orgId,
      confirmSlug: 'delete-cascade',
    });
    expect(result.slug).toBe('delete-cascade');

    /* Every count runs with app.org_id = the deleted org's id: the admin
       connection is subject to FORCE RLS, so a count with no org set would
       be zero whether or not rows remained — a vacuous pass. With the org
       selected, any leftover row still matches the policy and fails. */
    /* `identity.orgs` is the one table whose tenant column is `id`, not
       `org_id` — the tenant IS the row. */
    const remaining = async (table: string, where = 'org_id'): Promise<number> => {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where} = $1`,
        [orgId],
      );
      return Number(rows[0]?.['n']);
    };

    await admin.setOrg(orgId);
    expect(await remaining('identity.orgs', 'id')).toBe(0);
    expect(await remaining('identity.memberships')).toBe(0);
    expect(await remaining('work.projects')).toBe(0);
    expect(await remaining('chat.channels')).toBe(0);
    expect(await remaining('docs.spaces')).toBe(0);
    expect(await remaining('people.membership_profiles')).toBe(0);
    expect(await remaining('platform.outbox')).toBe(0);
    expect(await remaining('audit.audit_log')).toBe(0);
    expect(await remaining('audit.chain_heads')).toBe(0);
    await admin.setOrg(null);

    /* The typed event published with the SYSTEM_ORG envelope (guardrail 11). */
    expect(events.events.some((event) => event.name === 'platform.org_deleted')).toBe(true);

    /* The final accountability record — the GLOBAL operator chain, carrying
       the confirmation slug the operator typed. */
    const entries = await readOperatorAudit({ limit: 50, before: null });
    const deletion = entries.find((entry) => entry.action === 'orgs.delete');
    expect(deletion).toBeDefined();
    expect(deletion?.target).toMatchObject({
      orgId,
      slug: 'delete-cascade',
      confirmSlug: 'delete-cascade',
    });
  });
});
