import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneNumberSchema, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakeTelephonyProvider } from '@taskflow/telephony';
import { SoftwareKeyProvider } from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import type { TelephonyDeps } from './deps.js';
import type { TelephonyActor } from './shared.js';
import { checkPhoneVerification, startPhoneVerification } from './verify.service.js';

/**
 * Twilio Verify, against real Postgres (ai/phase-7-voice.md §3.12, Wave 4).
 *
 * The two properties this file exists to pin, in order of how expensive they
 * are to get wrong:
 *
 *   1. `startPhoneVerification` goes through the SAME `checkOutboundAllowed`
 *      gate as `placeCall`/`sendSms` — a refusal must leave the provider
 *      untouched, exactly as `spend-gate.test.ts` asserts for the other two
 *      outbound kinds. A verification code is not a special case §3.3 forgot
 *      to gate.
 *   2. `checkPhoneVerification` writes NO ledger row — it costs nothing to
 *      check a code, and a test asserting the ledger stays empty after a
 *      check is what would catch a future change that accidentally re-runs
 *      the gate (and its velocity limiter) on every guess.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee40-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195ee40-0000-7000-8000-0000000000ff');
const USERS: readonly [UserId, string][] = [[OWNER, 'owner@telephony-verify.test']];

const ALLOWED_TO = PhoneNumberSchema.parse('+14155550100');
/** Dominican Republic — a +1 number that is not the US or Canada. */
const PREMIUM_TO = PhoneNumberSchema.parse('+18095550100');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: [{ id: MASTER_KEY_ID, key: new Uint8Array(32).fill(7) }],
});

let admin: AdminConnection;
let created: OrgId[] = [];
let provider: FakeTelephonyProvider;

function depsFor(cap = 2500): TelephonyDeps {
  return {
    telephony: provider,
    keys,
    indexKey: new Uint8Array(32).fill(9),
    storage: undefined,
    recordingsBucket: undefined,
    defaultSpendCapCents: cap,
    maxSpendCapCents: 100_000,
    webhookOrigin: undefined,
  };
}

async function actorFor(orgId: OrgId): Promise<TelephonyActor> {
  const tuples = await loadTuples(orgId, OWNER);
  const subject: Subject = { orgId, userId: OWNER, role: 'owner', tuples };
  return { subject, requestId };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

/** Gives an org a subaccount row, without going through the carrier. */
async function giveSubaccount(orgId: OrgId): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.subaccounts).values({
      orgId,
      provider: 'twilio',
      subaccountSid: `AC${orgId.replace(/-/g, '')}`,
      authTokenCiphertext: Buffer.from('ciphertext'),
      dataKeyWrapped: Buffer.from('wrapped'),
      dataKeyMasterId: MASTER_KEY_ID,
      status: 'active',
    });
  });
}

async function readyOrg(slug: string): Promise<OrgId> {
  const orgId = await newOrg(slug);
  await giveSubaccount(orgId);
  return orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.spend_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.subaccounts WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tel-verify-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
  provider = new FakeTelephonyProvider();
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

async function outboxNames(orgId: OrgId): Promise<readonly string[]> {
  await admin.setOrg(orgId);
  const result = await admin.query(`SELECT name FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.setOrg(null);
  return result.rows.map((row) => row['name'] as string);
}

async function ledgerCount(orgId: OrgId): Promise<number> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT count(*)::int AS n FROM comms.spend_ledger WHERE org_id = $1`,
    [orgId],
  );
  await admin.setOrg(null);
  return (result.rows[0]?.['n'] as number | undefined) ?? 0;
}

describe('startPhoneVerification', () => {
  it('starts a verification, records spend, and emits verification.started', async () => {
    const orgId = await readyOrg('verify-start');
    const actor = await actorFor(orgId);

    const result = await startPhoneVerification(actor, depsFor(), {
      to: ALLOWED_TO,
      channel: 'sms',
    });

    expect(result.sid).toMatch(/^VE/);
    expect(await ledgerCount(orgId)).toBe(1);
    expect(await outboxNames(orgId)).toContain('verification.started');
  });

  it('refuses a premium destination WITHOUT ever calling the provider', async () => {
    /* The property `spend-gate.test.ts` calls the acceptance bar for the whole
       gate: a refusal must leave the provider untouched, not merely return
       `allowed: false` after already spending. */
    const orgId = await readyOrg('verify-geo');
    const actor = await actorFor(orgId);

    await expect(
      startPhoneVerification(actor, depsFor(), { to: PREMIUM_TO, channel: 'sms' }),
    ).rejects.toThrow();

    expect(provider.verifications.size).toBe(0);
    expect(await ledgerCount(orgId)).toBe(0);
  });

  it('refuses once the org is over its spend cap, and emits spend.limit_exceeded', async () => {
    const orgId = await readyOrg('verify-cap');
    const actor = await actorFor(orgId);

    /* A cap of 0 refuses the very first attempt — `estimatedCents` for any
       positive-cost action always exceeds it. */
    await expect(
      startPhoneVerification(actor, depsFor(0), { to: ALLOWED_TO, channel: 'sms' }),
    ).rejects.toThrow();

    expect(provider.verifications.size).toBe(0);
    expect(await outboxNames(orgId)).toContain('spend.limit_exceeded');
  });
});

describe('checkPhoneVerification', () => {
  it('approves the correct code and emits verification.succeeded', async () => {
    const orgId = await readyOrg('verify-check-ok');
    const actor = await actorFor(orgId);
    await startPhoneVerification(actor, depsFor(), { to: ALLOWED_TO, channel: 'sms' });

    const result = await checkPhoneVerification(actor, depsFor(), {
      to: ALLOWED_TO,
      code: '123456',
    });

    expect(result.approved).toBe(true);
    expect(await outboxNames(orgId)).toContain('verification.succeeded');
  });

  it('refuses the wrong code and emits verification.failed', async () => {
    const orgId = await readyOrg('verify-check-bad');
    const actor = await actorFor(orgId);
    await startPhoneVerification(actor, depsFor(), { to: ALLOWED_TO, channel: 'sms' });

    const result = await checkPhoneVerification(actor, depsFor(), {
      to: ALLOWED_TO,
      code: '000000',
    });

    expect(result.approved).toBe(false);
    expect(await outboxNames(orgId)).toContain('verification.failed');
  });

  it('writes no ledger row — checking a code costs nothing to check', async () => {
    const orgId = await readyOrg('verify-check-no-spend');
    const actor = await actorFor(orgId);
    await startPhoneVerification(actor, depsFor(), { to: ALLOWED_TO, channel: 'sms' });
    expect(await ledgerCount(orgId)).toBe(1);

    await checkPhoneVerification(actor, depsFor(), { to: ALLOWED_TO, code: '123456' });
    await checkPhoneVerification(actor, depsFor(), { to: ALLOWED_TO, code: 'wrong-again' });

    /* Still exactly the one row `startPhoneVerification` wrote. */
    expect(await ledgerCount(orgId)).toBe(1);
  });
});
