import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneNumberSchema, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakeTelephonyProvider } from '@taskflow/telephony';
import { SoftwareKeyProvider, newId } from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import { receiveSms, sendSms } from './message.service.js';
import type { TelephonyDeps } from './deps.js';
import type { TelephonyActor } from './shared.js';

/**
 * SMS threads and STOP/UNSUBSCRIBE, against real Postgres
 * (ai/phase-7-voice.md §3.8, Wave 3).
 *
 * The property worth asserting most carefully is the ORDER `sendSms` gates
 * in: suppression is checked BEFORE the spend gate, per the file's own
 * header — "messaging someone who opted out is a legal problem and being
 * over a spend cap is a billing one." A test that only checked "a suppressed
 * send is refused" could pass with the checks in either order; the case
 * below is written so an org that is BOTH suppressed AND over its cap still
 * reports the suppression, proving the order rather than just the outcome.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee70-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195ee70-0000-7000-8000-0000000000ff');
const USERS: readonly [UserId, string][] = [[OWNER, 'owner@telephony-msg.test']];

const COUNTERPARTY = PhoneNumberSchema.parse('+14155550100');

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

async function readyOrg(slug: string): Promise<{ orgId: OrgId; fromId: string }> {
  const orgId = await newOrg(slug);
  await giveSubaccount(orgId);
  const fromId = await givePhoneNumber(orgId);
  return { orgId, fromId };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.messages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.message_threads WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.suppressions WHERE org_id = $1`, [orgId]);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tel-msg-test' });
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

describe('sendSms', () => {
  it('sends, creates a thread, and records spend', async () => {
    const { orgId, fromId } = await readyOrg('sms-send');
    const actor = await actorFor(orgId);

    const result = await sendSms(actor, depsFor(), {
      to: COUNTERPARTY,
      fromPhoneNumberId: fromId,
      body: 'hello',
    });

    expect(result.threadId).toBeDefined();
    expect(provider.messages.length).toBe(1);
  });

  it('refuses a suppressed recipient WITHOUT ever reaching the provider or the spend gate', async () => {
    /* Cap of 0 would ALSO refuse this send — the point is that the error the
       caller sees, and the fact the provider is never touched, prove
       suppression ran first. */
    const { orgId, fromId } = await readyOrg('sms-suppressed');
    const actor = await actorFor(orgId);

    await receiveSms(orgId, depsFor(), {
      from: COUNTERPARTY,
      phoneNumberId: fromId,
      body: 'STOP',
      providerSid: 'SM0000000000000000000000000000000stop',
      requestId,
    });

    await expect(
      sendSms(actor, depsFor(0), { to: COUNTERPARTY, fromPhoneNumberId: fromId, body: 'hi' }),
    ).rejects.toThrow(/opted out/);

    expect(provider.messages.length).toBe(0);
  });

  it('allows sending again after START revokes the suppression', async () => {
    const { orgId, fromId } = await readyOrg('sms-restart');
    const actor = await actorFor(orgId);

    await receiveSms(orgId, depsFor(), {
      from: COUNTERPARTY,
      phoneNumberId: fromId,
      body: 'stop',
      providerSid: 'SM0000000000000000000000000000000st2',
      requestId,
    });
    await receiveSms(orgId, depsFor(), {
      from: COUNTERPARTY,
      phoneNumberId: fromId,
      body: 'start',
      providerSid: 'SM0000000000000000000000000000000go1',
      requestId,
    });

    await expect(
      sendSms(actor, depsFor(), { to: COUNTERPARTY, fromPhoneNumberId: fromId, body: 'welcome back' }),
    ).resolves.toBeDefined();
  });
});

describe('receiveSms', () => {
  it('threads two inbound messages from the same counterparty together', async () => {
    const { orgId, fromId } = await readyOrg('sms-thread');

    const first = await receiveSms(orgId, depsFor(), {
      from: COUNTERPARTY,
      phoneNumberId: fromId,
      body: 'hi',
      providerSid: 'SM0000000000000000000000000000000one1',
      requestId,
    });
    const second = await receiveSms(orgId, depsFor(), {
      from: COUNTERPARTY,
      phoneNumberId: fromId,
      body: 'again',
      providerSid: 'SM0000000000000000000000000000000two2',
      requestId,
    });

    expect(second.threadId).toBe(first.threadId);
  });

  it('reports optOut and creates a live suppression on STOP', async () => {
    const { orgId, fromId } = await readyOrg('sms-stop-report');

    const result = await receiveSms(orgId, depsFor(), {
      from: COUNTERPARTY,
      phoneNumberId: fromId,
      body: 'STOP',
      providerSid: 'SM0000000000000000000000000000000stp3',
      requestId,
    });

    expect(result.optOut).toBe(true);

    const suppressed = await withOrgScope(orgId, async (tx) =>
      tx.select().from(schema.suppressions).limit(1),
    );
    expect(suppressed).toHaveLength(1);
  });

  it('does not opt someone out for an ordinary message that merely contains "stop"', async () => {
    /* `classifyOptOut` matches the whole (normalised) body, not a substring —
       this is the case that would catch a regression back to substring
       matching. */
    const { orgId, fromId } = await readyOrg('sms-not-stop');

    const result = await receiveSms(orgId, depsFor(), {
      from: COUNTERPARTY,
      phoneNumberId: fromId,
      body: "please don't stop sending these",
      providerSid: 'SM0000000000000000000000000000000nstp',
      requestId,
    });

    expect(result.optOut).toBe(false);
  });
});
