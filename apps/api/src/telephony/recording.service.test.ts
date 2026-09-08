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
import * as projects from '../work/project.service.js';
import * as boards from '../work/board.service.js';
import * as lists from '../work/list.service.js';
import * as cards from '../work/card.service.js';
import type { WorkActor } from '../work/shared.js';
import { placeCall } from './call.service.js';
import { attachRecordingToCard } from './recording-card.service.js';
import { listOrgRecordings, registerRecording } from './recording.service.js';
import type { TelephonyDeps } from './deps.js';
import type { TelephonyActor } from './shared.js';

/**
 * The org-wide recordings browser (`recordings.browse`) — the gap
 * `recording-section.tsx`'s own header names: only per-call and per-card
 * lists existed. The property only real Postgres proves is the SAME
 * counterparty-decryption path `listCalls` already uses working across a
 * JOIN, and the `createdAt` cursor actually excluding what came before it.
 */

const OWNER = unsafeAsId<'UserId'>('0195f600-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195f600-0000-7000-8000-000000000002');
const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@telephony-org-recordings.test'],
  [MEMBER, 'member@telephony-org-recordings.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195f600-0000-7000-8000-0000000000ff');
const TO = PhoneNumberSchema.parse('+14155550100');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: [{ id: MASTER_KEY_ID, key: new Uint8Array(32).fill(7) }],
});

let admin: AdminConnection;
let created: OrgId[] = [];
let provider: FakeTelephonyProvider;

function depsFor(): TelephonyDeps {
  return {
    telephony: provider,
    keys,
    indexKey: new Uint8Array(32).fill(9),
    storage: undefined,
    recordingsBucket: undefined,
    defaultSpendCapCents: 2500,
    maxSpendCapCents: 100_000,
    webhookOrigin: undefined,
  };
}

async function telephonyActor(orgId: OrgId, userId: UserId, role: Subject['role']) {
  const tuples = await loadTuples(orgId, userId);
  const subject: Subject = { orgId, userId, role, tuples };
  return { subject, requestId } satisfies TelephonyActor;
}

async function workActor(orgId: OrgId, userId: UserId, role: Subject['role']) {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId } satisfies WorkActor;
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function giveSubaccount(orgId: OrgId): Promise<void> {
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

async function readyOrg(slug: string): Promise<OrgId> {
  const orgId = await newOrg(slug);
  await giveSubaccount(orgId);
  return orgId;
}

let recordingSuffix = 0;

async function recordCall(
  orgId: OrgId,
  fromPhoneNumberId: string,
): Promise<{ readonly callId: string; readonly recordingId: string }> {
  const owner = await telephonyActor(orgId, OWNER, 'owner');
  const placed = await placeCall(owner, depsFor(), {
    to: TO,
    fromPhoneNumberId,
    record: false,
  });
  recordingSuffix += 1;
  const providerSid = `RE${String(recordingSuffix).padStart(32, '0')}`;
  const registered = await registerRecording(orgId, {
    callId: placed.callId,
    providerSid,
    providerUrl: 'https://example.test/recording.mp3',
    durationSeconds: 30,
    requestId,
  });
  await withOrgScope(orgId, async (tx) => {
    // `recordings_stored_has_key` (migration 0033) refuses `status = 'stored'`
    // with no `stored_at` — a 'stored' row with no key is unrepresentable by
    // design, and that includes the timestamp half of "stored", not just the
    // key.
    await tx
      .update(schema.recordings)
      .set({
        status: 'stored',
        storageKey: `recordings/${registered.recordingId}`,
        storedAt: new Date(),
      })
      .where(eq(schema.recordings.id, registered.recordingId));
  });
  return { callId: placed.callId, recordingId: registered.recordingId };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.recording_cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.recordings WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.calls WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.phone_numbers WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.spend_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.subaccounts WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.views WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tel-org-rec-test' });
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

describe('listOrgRecordings', () => {
  it('returns an empty page for an org with no recordings', async () => {
    const orgId = await readyOrg('org-rec-empty');
    const owner = await telephonyActor(orgId, OWNER, 'owner');

    const result = await listOrgRecordings(owner, depsFor(), { limit: 50, before: null });
    expect(result).toEqual([]);
  });

  it('decrypts the counterparty and reports direction and status', async () => {
    const orgId = await readyOrg('org-rec-basic');
    const fromId = await givePhoneNumber(orgId);
    const owner = await telephonyActor(orgId, OWNER, 'owner');

    const { recordingId, callId } = await recordCall(orgId, fromId);

    const result = await listOrgRecordings(owner, depsFor(), { limit: 50, before: null });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      recordingId,
      callId,
      status: 'stored',
      direction: 'outbound',
      counterparty: TO,
      attachedCardIds: [],
    });
  });

  it('includes cards a recording has been attached to', async () => {
    const orgId = await readyOrg('org-rec-card');
    const fromId = await givePhoneNumber(orgId);
    const owner = await telephonyActor(orgId, OWNER, 'owner');
    const workOwner = await workActor(orgId, OWNER, 'owner');

    const { recordingId } = await recordCall(orgId, fromId);

    const project = await projects.createProject(workOwner, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });
    const board = await boards.createBoard(workOwner, {
      projectId: project.projectId,
      name: 'Delivery',
    });
    const list = await lists.createList(workOwner, {
      boardId: board.boardId,
      wipLimit: null,
      name: 'Todo',
    });
    const card = await cards.createCard(workOwner, {
      listId: list.listId,
      title: 'Follow up on the call',
      description: null,
    });

    await attachRecordingToCard(owner, { recordingId, cardId: card.cardId });

    const result = await listOrgRecordings(owner, depsFor(), { limit: 50, before: null });
    expect(result[0]?.attachedCardIds).toEqual([card.cardId]);
  });

  it('the before cursor excludes recordings at or after it', async () => {
    const orgId = await readyOrg('org-rec-cursor');
    const fromId = await givePhoneNumber(orgId);
    const owner = await telephonyActor(orgId, OWNER, 'owner');

    const first = await recordCall(orgId, fromId);
    const second = await recordCall(orgId, fromId);

    const firstPage = await listOrgRecordings(owner, depsFor(), { limit: 1, before: null });
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]?.recordingId).toBe(second.recordingId);

    const secondPage = await listOrgRecordings(owner, depsFor(), {
      limit: 1,
      before: firstPage[0]?.createdAt ?? new Date(),
    });
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]?.recordingId).toBe(first.recordingId);
  });

  it('refuses a member — recording:read is Admin-and-Owner only', async () => {
    const orgId = await readyOrg('org-rec-refuse');
    const fromId = await givePhoneNumber(orgId);
    await recordCall(orgId, fromId);

    const member = await telephonyActor(orgId, MEMBER, 'member');
    await expect(
      listOrgRecordings(member, depsFor(), { limit: 50, before: null }),
    ).rejects.toBeDefined();
  });
});
