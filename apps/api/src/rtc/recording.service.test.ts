import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, eq, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as channels from '../chat/channel.service.js';
import type { ChatActor } from '../chat/shared.js';
import * as sessions from './session.service.js';
import * as recordings from './recording.service.js';
import type { RtcActor } from './shared.js';

/**
 * The recording consent gate, against real Postgres (ai/phase-13-webrtc.md §3.9).
 *
 * ## The assertion this file exists for
 *
 * `refuses to reach 'active' while somebody has not agreed — in the DATABASE`.
 *
 * §3.9 deferred recording from Wave 1 with one condition: the consent gate
 * applies exactly as it does for PSTN, and Phase 7's bar is that the third
 * layer is a thing the database will not let be wrong
 * (`calls_recording_after_announcement`). The equivalent here is
 * `sessions_recording_needs_consent`, and a test that only exercised
 * `startRecording`'s readable error would pass just as happily against a
 * service with no constraint behind it — which is the version that breaks
 * silently the day somebody adds a second write path.
 *
 * ⚠ Fixture prefix `0195ee15`, used by no other suite — see
 * `session.service.test.ts`'s note on why that matters.
 */

const ALICE = unsafeAsId<'UserId'>('0195ee15-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195ee15-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [ALICE, 'alice@rec.test'],
  [BOB, 'bob@rec.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee15-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function actorFor(
  orgId: OrgId,
  userId: UserId,
  role: Subject['role'] = 'member',
): Promise<RtcActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

const asChat = (actor: RtcActor): ChatActor => actor;

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: ALICE, requestId });
  created.push(result.orgId);
  await members.addMember(
    result.orgId,
    { email: 'bob@rec.test', role: 'member' },
    { userId: ALICE, requestId },
  );
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM rtc.recordings WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM rtc.turn_issuance WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM rtc.participants WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM rtc.sessions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM chat.channels WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** A live 1:1 call between Alice and Bob, both joined. */
async function liveCall(orgId: OrgId): Promise<string> {
  const creator = await actorFor(orgId, ALICE, 'owner');
  const { channelId } = await channels.openDirectMessage(asChat(creator), { userIds: [BOB] });

  /* Rebuilt after the DM exists — an actor carries its tuples, and one built
     before `openDirectMessage` wrote them holds the old answer. */
  const alice = await actorFor(orgId, ALICE, 'owner');
  const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
  await sessions.joinSession(await actorFor(orgId, BOB), { sessionId });
  return sessionId;
}

async function sessionRow(orgId: OrgId, sessionId: string) {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.rtcSessions)
      .where(eq(schema.rtcSessions.id, sessionId))
      .limit(1);
    return rows[0];
  });
}

async function rejectionCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error thrown';
  } catch (error) {
    return isAppError(error) ? error.code : `non-AppError: ${String(error)}`;
  }
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-rec-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
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

describe('the recording consent gate', () => {
  it('refuses to reach active while somebody has not agreed — in the DATABASE', async () => {
    const orgId = await newOrg('rec-check');
    const sessionId = await liveCall(orgId);

    const alice = await actorFor(orgId, ALICE, 'owner');
    await recordings.requestRecording(alice, { sessionId });

    /* Alice's own consent was recorded by the request. Bob has not answered, so
       consent_count (1) < joined_count (2). */
    const pending = await sessionRow(orgId, sessionId);
    expect(pending?.recordingState).toBe('pending');
    expect(pending?.consentCount).toBe(1);
    expect(pending?.joinedCount).toBe(2);

    /* THE assertion. Not the service's readable refusal — the CONSTRAINT.
       Written through the migrator connection, bypassing every line of
       `recording.service.ts`, because §3.9's whole bar is that a second write
       path added later cannot record without consent either. */
    await admin.setOrg(orgId);
    const violation = await admin
      .query(
        `UPDATE rtc.sessions SET recording_state = 'active', recording_started_at = now()
         WHERE id = $1`,
        [sessionId],
      )
      .then(() => null)
      .catch((error: unknown) => error);
    await admin.setOrg(null);

    expect(violation).not.toBeNull();
    expect(String(violation)).toMatch(/sessions_recording_needs_consent/);
  });

  it('refuses the service call too, with a reason a caller can act on', async () => {
    const orgId = await newOrg('rec-service');
    const sessionId = await liveCall(orgId);
    const alice = await actorFor(orgId, ALICE, 'owner');

    await recordings.requestRecording(alice, { sessionId });

    expect(await rejectionCode(() => recordings.startRecording(alice, { sessionId }))).toBe(
      'CONFLICT',
    );
  });

  it('starts once everybody has agreed', async () => {
    const orgId = await newOrg('rec-agree');
    const sessionId = await liveCall(orgId);
    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);

    await recordings.requestRecording(alice, { sessionId });
    await recordings.answerRecording(bob, { sessionId, agreed: true });

    const { recordingId } = await recordings.startRecording(alice, { sessionId });

    const active = await sessionRow(orgId, sessionId);
    expect(active?.recordingState).toBe('active');
    expect(active?.recordingStartedAt).not.toBeNull();

    const rows = await withOrgScope(orgId, async (tx) =>
      tx
        .select({ status: schema.rtcRecordings.status, key: schema.rtcRecordings.storageKey })
        .from(schema.rtcRecordings)
        .where(eq(schema.rtcRecordings.id, recordingId)),
    );

    expect(rows[0]?.status).toBe('pending');
    /* SERVER-GENERATED, from ids this server minted. Nothing a client sent
       reaches it — the traversal this design removes rather than mitigates. */
    expect(rows[0]?.key).toBe(`rtc/${orgId}/${sessionId}/${recordingId}.webm`);
  });

  it('a single refusal ends the request for everyone', async () => {
    const orgId = await newOrg('rec-refuse');
    const sessionId = await liveCall(orgId);
    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);

    await recordings.requestRecording(alice, { sessionId });
    await recordings.answerRecording(bob, { sessionId, agreed: false });

    /* Back to `none`, not left `pending`. A refusal that left the request open
       would show the person who said no a "waiting for consent" bar they had
       already answered, and the person who asked would keep waiting for an
       answer that had already arrived. */
    const after = await sessionRow(orgId, sessionId);
    expect(after?.recordingState).toBe('none');
    expect(after?.consentCount).toBe(0);

    expect(await rejectionCode(() => recordings.startRecording(alice, { sessionId }))).toBe(
      'CONFLICT',
    );
  });

  it('there is no admin override — an owner cannot record over a refusal', async () => {
    const orgId = await newOrg('rec-no-override');
    const sessionId = await liveCall(orgId);
    /* Alice is the org OWNER, the highest role in the matrix. */
    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);

    await recordings.requestRecording(alice, { sessionId });
    await recordings.answerRecording(bob, { sessionId, agreed: false });

    /* A capability that let an owner record over an objection would make the
       consent gate decorative — and the org's own admin is exactly who a
       participant most needs to be able to refuse. */
    expect(await rejectionCode(() => recordings.startRecording(alice, { sessionId }))).toBe(
      'CONFLICT',
    );
    expect((await sessionRow(orgId, sessionId))?.recordingState).toBe('none');
  });

  it('clears consent when recording stops, so the next request asks again', async () => {
    const orgId = await newOrg('rec-reset');
    const sessionId = await liveCall(orgId);
    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);

    await recordings.requestRecording(alice, { sessionId });
    await recordings.answerRecording(bob, { sessionId, agreed: true });
    await recordings.startRecording(alice, { sessionId });
    await recordings.stopRecording(alice, { sessionId });

    const stopped = await sessionRow(orgId, sessionId);
    expect(stopped?.recordingState).toBe('stopped');
    /* Agreeing once must not make you recordable for the rest of the call —
       that is the difference between "you agreed to be recorded" and "you
       agreed to be recordable", and only the first is a thing anybody agreed
       to. */
    expect(stopped?.consentCount).toBe(0);

    const status = await recordings.recordingStatus(bob, { sessionId });
    expect(status.consented).toEqual([]);
    expect(status.awaiting).toHaveLength(2);
  });

  it('refuses a caller who cannot read the conversation', async () => {
    const orgId = await newOrg('rec-authz');
    const sessionId = await liveCall(orgId);

    /* A member of the org with no tuple on this DM. NOT_FOUND rather than
       FORBIDDEN — `enforce()` tells somebody who cannot READ a resource that it
       does not exist, because a 403 on a session id would confirm two specific
       people are on a call (§8.7). */
    const outsiderId = unsafeAsId<'UserId'>('0195ee15-0000-7000-8000-0000000000aa');
    await admin.setOrg(null);
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now()) ON CONFLICT DO NOTHING`,
      [outsiderId, 'outsider@rec.test'],
    );
    await members.addMember(
      orgId,
      { email: 'outsider@rec.test', role: 'member' },
      { userId: ALICE, requestId },
    );

    const outsider = await actorFor(orgId, outsiderId);
    expect(await rejectionCode(() => recordings.requestRecording(outsider, { sessionId }))).toBe(
      'NOT_FOUND',
    );

    await admin.setOrg(null);
    await admin.query(`DELETE FROM identity.memberships WHERE user_id = $1`, [outsiderId]);
    await admin.query(`DELETE FROM identity.users WHERE id = $1`, [outsiderId]);
  });
});
