import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneNumberSchema, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, eq, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakeTelephonyProvider } from '@taskflow/telephony';
import { SoftwareKeyProvider, newId } from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import { applyCallStatus, markAnnouncementPlayed, placeCall } from './call.service.js';
import { registerRecording } from './recording.service.js';
import type { TelephonyDeps } from './deps.js';
import type { TelephonyActor } from './shared.js';

/**
 * Calls and the consent gate, against real Postgres (ai/phase-7-voice.md §3.5,
 * §3.10). ⚠ Human-review surface.
 *
 * The invariant worth a real database for is the one described in
 * `call.service.ts`'s own header: three layers, and only the THIRD — the
 * `calls_recording_after_announcement` CHECK constraint — is a thing the
 * database will not let be wrong. `'starts recording only after a required
 * announcement played'` below is what proves layer three actually fires; every
 * other assertion here could pass against a mock that simply trusted the
 * service's own bookkeeping.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee60-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195ee60-0000-7000-8000-0000000000ff');
const USERS: readonly [UserId, string][] = [[OWNER, 'owner@telephony-call.test']];

/** A California number — deterministically ALL-PARTY by area code alone. */
const ALL_PARTY_TO = PhoneNumberSchema.parse('+14155550100');
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

async function giveSubaccount(orgId: OrgId): Promise<void> {
  /* A REAL wrapped data key, not a placeholder — `placeCall` decrypts the
     counterparty number through it (`loadOrgDataKey`), and `SoftwareKeyProvider`
     refuses to unwrap bytes it did not itself wrap. `subaccount.service.ts`'s
     `ensureSubaccount` is the pattern this mirrors. */
  const dataKey = await keys.generateDataKey({ orgId });
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.subaccounts).values({
      orgId,
      provider: 'twilio',
      subaccountSid: `AC${orgId.replace(/-/g, '')}`,
      authTokenCiphertext: Buffer.from('ciphertext'),
      dataKeyWrapped: Buffer.from(dataKey.wrapped.wrapped),
      dataKeyMasterId: dataKey.wrapped.masterKeyId,
      status: 'active',
    });
  });
}

async function readyOrg(slug: string): Promise<OrgId> {
  const orgId = await newOrg(slug);
  await giveSubaccount(orgId);
  return orgId;
}

async function givePhoneNumber(orgId: OrgId): Promise<string> {
  return withOrgScope(orgId, async (tx) => {
    const [row] = await tx
      .insert(schema.phoneNumbers)
      .values({
        id: newId<'PhoneNumberId'>(),
        orgId,
        e164: '+15005550006',
        providerSid: 'PN0000000000000000000000000000000000',
        isoCountry: 'US',
      })
      .returning({ id: schema.phoneNumbers.id });
    if (row === undefined) throw new Error('failed to seed a phone number');
    return row.id;
  });
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.recordings WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.calls WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.phone_numbers WHERE org_id = $1`, [orgId]);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tel-call-test' });
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

describe('placeCall', () => {
  it('does not require an announcement when recording was not requested', async () => {
    const orgId = await readyOrg('call-no-record');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    const result = await placeCall(actor, depsFor(), {
      to: ALL_PARTY_TO,
      fromPhoneNumberId: fromId,
      record: false,
    });

    expect(result.announcementRequired).toBe(false);
    expect(await outboxNames(orgId)).not.toContain('call.consent_recorded');
  });

  it('requires the announcement for an all-party destination and records the consent decision', async () => {
    const orgId = await readyOrg('call-record');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    const result = await placeCall(actor, depsFor(), {
      to: ALL_PARTY_TO,
      fromPhoneNumberId: fromId,
      record: true,
    });

    expect(result.announcementRequired).toBe(true);
    expect(await outboxNames(orgId)).toContain('call.consent_recorded');
    expect(provider.calls.length).toBe(1);
  });

  it('attaches each call’s provider sid to its OWN ledger row', async () => {
    /* Every other case here places exactly ONE call into a fresh org, which is
       precisely why this survived: the post-carrier UPDATE matched the ledger
       row by `(org_id, kind, estimated_cents)` — a description every previously
       placed call at the same price also satisfies. The second call therefore
       tried to stamp its SID onto both rows and was refused by
       `spend_ledger_provider_sid_key`, AFTER the carrier had already dialed. So
       the assertion that matters is two calls in ONE org at the SAME price. */
    const orgId = await readyOrg('call-ledger-sid');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    const first = await placeCall(actor, depsFor(), {
      to: ALL_PARTY_TO,
      fromPhoneNumberId: fromId,
      record: false,
    });
    const second = await placeCall(actor, depsFor(), {
      to: ALL_PARTY_TO,
      fromPhoneNumberId: fromId,
      record: false,
    });

    const callSids = await withOrgScope(orgId, async (tx) =>
      tx.select({ id: schema.calls.id, providerSid: schema.calls.providerSid }).from(schema.calls),
    );
    const ledgerSids = await withOrgScope(orgId, async (tx) =>
      tx
        .select({ providerSid: schema.spendLedger.providerSid })
        .from(schema.spendLedger)
        .where(eq(schema.spendLedger.kind, 'call')),
    );

    const expected = [first.callId, second.callId].map(
      (id) => callSids.find((row) => row.id === id)?.providerSid,
    );
    expect(expected.every((sid) => typeof sid === 'string')).toBe(true);
    expect(new Set(expected).size).toBe(2);
    expect(ledgerSids.map((row) => row.providerSid).sort()).toEqual([...expected].sort());
  });

  it('refuses a premium destination without ever reaching the provider', async () => {
    const orgId = await readyOrg('call-geo');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    await expect(
      placeCall(actor, depsFor(), { to: PREMIUM_TO, fromPhoneNumberId: fromId, record: false }),
    ).rejects.toThrow();

    expect(provider.calls.length).toBe(0);
  });

  it('refuses over the spend cap and emits spend.limit_exceeded', async () => {
    const orgId = await readyOrg('call-cap');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    await expect(
      placeCall(actor, depsFor(0), { to: ALL_PARTY_TO, fromPhoneNumberId: fromId, record: false }),
    ).rejects.toThrow();

    expect(provider.calls.length).toBe(0);
    expect(await outboxNames(orgId)).toContain('spend.limit_exceeded');
  });
});

describe('automation-initiated calls (Phase 10 Wave 4 §5.5)', () => {
  it('attributes the ledger row under automation_call, never call', async () => {
    const orgId = await readyOrg('call-auto-kind');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    const result = await placeCall(
      actor,
      depsFor(),
      { to: ALL_PARTY_TO, fromPhoneNumberId: fromId, record: false },
      { initiatedBy: 'automation' },
    );

    expect(result.callId).toBeTruthy();
    /* The call is an ordinary call row; the ATTRIBUTION lives in the ledger
       kind — the thing the sub-budget sums and spendReport groups. A rule's
       call that wrote kind 'call' would consume the human allowance. */
    const ledger = await withOrgScope(orgId, async (tx) =>
      tx.select({ kind: schema.spendLedger.kind }).from(schema.spendLedger),
    );
    expect(ledger.map((row) => row.kind)).toEqual(['automation_call']);
    expect(provider.calls.length).toBe(1);
  });

  it('passes the SAME gate — a premium destination is refused before the provider', async () => {
    /* The one property §5.5 restates at the top: an automation action is not
       a different gate. A rule's call to a disallowed destination must be
       refused identically to a human's, before the carrier hears anything. */
    const orgId = await readyOrg('call-auto-geo');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    await expect(
      placeCall(
        actor,
        depsFor(),
        { to: PREMIUM_TO, fromPhoneNumberId: fromId, record: false },
        { initiatedBy: 'automation' },
      ),
    ).rejects.toThrow();

    expect(provider.calls.length).toBe(0);
  });
});

describe('the consent CHECK constraint', () => {
  it('refuses to start recording before a required announcement has played', async () => {
    const orgId = await readyOrg('call-check-blocks');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    const placed = await placeCall(actor, depsFor(), {
      to: ALL_PARTY_TO,
      fromPhoneNumberId: fromId,
      record: true,
    });
    expect(placed.announcementRequired).toBe(true);

    /* The announcement was never marked played. This is the database, not the
       service, refusing — the whole point of `call.service.ts`'s three-layer
       argument. */
    await expect(
      registerRecording(orgId, {
        callId: placed.callId,
        providerSid: 'RE00000000000000000000000000000000',
        providerUrl: 'https://example.test/recording.mp3',
        durationSeconds: 30,
        requestId,
      }),
    ).rejects.toThrow();
  });

  it('allows recording once the announcement is marked played', async () => {
    const orgId = await readyOrg('call-check-allows');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);

    const placed = await placeCall(actor, depsFor(), {
      to: ALL_PARTY_TO,
      fromPhoneNumberId: fromId,
      record: true,
    });

    await markAnnouncementPlayed(orgId, placed.callId, requestId);
    expect(await outboxNames(orgId)).toContain('call.announcement_played');

    await expect(
      registerRecording(orgId, {
        callId: placed.callId,
        providerSid: 'RE00000000000000000000000000000001',
        providerUrl: 'https://example.test/recording.mp3',
        durationSeconds: 30,
        requestId,
      }),
    ).resolves.toBeDefined();
  });
});

describe('applyCallStatus', () => {
  it('is a no-op for a provider sid this org has no row for', async () => {
    const orgId = await readyOrg('call-status-unknown');
    await expect(
      applyCallStatus(orgId, {
        providerSid: 'CAunknown00000000000000000000000000',
        status: 'completed',
        requestId,
      }),
    ).resolves.toBeUndefined();
  });

  it('sets endedAt on a terminal status and emits call.status_changed', async () => {
    const orgId = await readyOrg('call-status-terminal');
    const fromId = await givePhoneNumber(orgId);
    const actor = await actorFor(orgId);
    const placed = await placeCall(actor, depsFor(), {
      to: ALL_PARTY_TO,
      fromPhoneNumberId: fromId,
      record: false,
    });

    const providerSid = await withOrgScope(orgId, async (tx) => {
      const rows = await tx
        .select({ providerSid: schema.calls.providerSid })
        .from(schema.calls)
        .where(eq(schema.calls.id, placed.callId))
        .limit(1);
      return rows[0]?.providerSid ?? undefined;
    });
    if (providerSid === undefined) throw new Error('placeCall did not record a provider sid');

    await applyCallStatus(orgId, {
      providerSid,
      status: 'completed',
      durationSeconds: 42,
      requestId,
    });

    const row = await withOrgScope(orgId, async (tx) => {
      const rows = await tx
        .select({ status: schema.calls.status, endedAt: schema.calls.endedAt })
        .from(schema.calls)
        .where(eq(schema.calls.id, placed.callId))
        .limit(1);
      return rows[0];
    });

    expect(row?.status).toBe('completed');
    expect(row?.endedAt).not.toBeNull();
    expect(await outboxNames(orgId)).toContain('call.status_changed');
  });
});
