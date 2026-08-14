import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isAppError,
  unsafeAsId,
  type ChannelId,
  type OrgId,
  type UserId,
} from '@taskflow/contracts';
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
import { MESH_PARTICIPANT_CAP } from './shared.js';
import type { RtcActor } from './shared.js';

/**
 * In-app call sessions against real Postgres (ai/phase-13-webrtc.md §1, §3.5, §3.6).
 *
 * ## What is worth a real database here, and what is not
 *
 * Three of the assertions below are decided by something other than this code,
 * and would be vacuous against a mock:
 *
 *   - **The mesh cap is a CHECK constraint.** `sessions_joined_within_cap` is
 *     what refuses the (N+1)th join, not the service — the service only
 *     translates the resulting SQLSTATE into a readable error. A test against a
 *     fake would assert that the translation exists, which is the half that
 *     cannot be wrong on its own.
 *   - **First-answer-wins is a conditional UPDATE.** Its verdict is a returned
 *     row count from Postgres.
 *   - **`can()` runs against tuples read from `authz.relationship_tuples`.**
 *     Every authorization assertion here goes through `loadTuples`, so what is
 *     being tested is the real decision on real rows — the §1 claim that a call
 *     authorizes exactly like its channel is only meaningful if the tuples are
 *     real.
 *
 * ## Fixture id prefix
 *
 * ⚠ `0195ee13`, used by no other suite. Turbo runs packages in parallel against
 * one `taskflow_test` and every suite deletes its own users by id, so two suites
 * sharing a prefix delete each other's rows mid-run — see
 * `chat.service.test.ts`'s own note, which lists the assignments.
 */

const ALICE = unsafeAsId<'UserId'>('0195ee13-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195ee13-0000-7000-8000-000000000002');
const CAROL = unsafeAsId<'UserId'>('0195ee13-0000-7000-8000-000000000003');
const DAVE = unsafeAsId<'UserId'>('0195ee13-0000-7000-8000-000000000004');
const ERIN = unsafeAsId<'UserId'>('0195ee13-0000-7000-8000-000000000005');
/** In the org, in no channel. The §1 assertion depends on this person existing. */
const OUTSIDER = unsafeAsId<'UserId'>('0195ee13-0000-7000-8000-000000000006');

const USERS: readonly [UserId, string][] = [
  [ALICE, 'alice@rtc.test'],
  [BOB, 'bob@rtc.test'],
  [CAROL, 'carol@rtc.test'],
  [DAVE, 'dave@rtc.test'],
  [ERIN, 'erin@rtc.test'],
  [OUTSIDER, 'outsider@rtc.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee13-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

/**
 * Rebuilt from the database on every call, never cached.
 *
 * An actor carries its tuples, and channel membership IS a tuple — so an actor
 * built before someone joined a channel still holds the old answer. Re-reading
 * is what makes "add Bob, then act as Bob" mean what it looks like it means.
 */
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
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  /* Children before parents — the ordering tenancy-seed.ts's clearTenant
     documents. rtc.turn_issuance and rtc.participants both reference
     rtc.sessions composite-with-org. */
  await admin.query(`DELETE FROM rtc.turn_issuance WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM rtc.participants WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM rtc.sessions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM chat.messages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM chat.channels WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** Adds everyone but Alice (the org's owner, who created it) as members. */
async function seedMembers(orgId: OrgId, userIds: readonly UserId[]): Promise<void> {
  for (const userId of userIds) {
    const email = USERS.find(([id]) => id === userId)?.[1];
    if (email === undefined) throw new Error(`No fixture email for ${userId}.`);
    await members.addMember(orgId, { email, role: 'member' }, { userId: ALICE, requestId });
  }
}

/** A DM between the given people, created by the first of them. */
async function dmBetween(orgId: OrgId, participants: readonly UserId[]): Promise<ChannelId> {
  const first = participants[0];
  if (first === undefined) throw new Error('dmBetween needs at least one participant.');
  const actor = await actorFor(orgId, first, first === ALICE ? 'owner' : 'member');
  const result = await channels.openDirectMessage(asChat(actor), {
    userIds: participants.slice(1),
  });
  return result.channelId;
}

/** The error code `fn` rejects with, or a description of why it did not. */
async function rejectionCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error thrown';
  } catch (error) {
    return isAppError(error) ? error.code : `non-AppError: ${String(error)}`;
  }
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-rtc-test' });
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

/* -------------------------------------------------------------------------- *
 * §1 — the authorization reuse
 * -------------------------------------------------------------------------- */

describe('a call authorizes exactly like its channel', () => {
  it('refuses someone who cannot read the DM, even though they are in the org', async () => {
    const orgId = await newOrg('rtc-authz');
    await seedMembers(orgId, [BOB, OUTSIDER]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    /* THE assertion this phase rests on. OUTSIDER is a `member` of the org and
       therefore holds `channel:read` from the ROLE matrix — a target built
       without `closed` would let them straight in. `channelTarget` carries it,
       so the DM is reachable only through a tuple they do not have.

       NOT_FOUND rather than FORBIDDEN, and that is `enforce()` working as
       designed (§8.7): a caller who cannot even READ a resource is told it does
       not exist, because "403 on this id" confirms the conversation is real.
       Asserting FORBIDDEN here would be asserting an information leak. */
    const outsider = await actorFor(orgId, OUTSIDER);
    expect(await rejectionCode(() => sessions.joinSession(outsider, { sessionId }))).toBe(
      'NOT_FOUND',
    );
  });

  it('lets the person who was rung join, and records them as a participant', async () => {
    const orgId = await newOrg('rtc-join');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const started = await sessions.startSession(alice, { channelId, kind: 'audio' });
    expect(started.invitedUserIds).toEqual([BOB]);

    const bob = await actorFor(orgId, BOB);
    const view = await sessions.joinSession(bob, { sessionId: started.sessionId });

    expect(view.status).toBe('active');
    expect(view.joinedCount).toBe(2);
    expect(view.participants.find((p) => p.userId === BOB)?.state).toBe('joined');
  });

  it('refuses a viewer STARTING a call while letting them join one (§3.8)', async () => {
    const orgId = await newOrg('rtc-viewer');
    await seedMembers(orgId, [BOB, CAROL]);

    /* A private channel rather than a DM: a DM's participants are fixed and
       there is no way to give one of them a `viewer` tuple instead of `member`,
       which is exactly the distinction this test is about. */
    const creator = await actorFor(orgId, ALICE, 'owner');
    const { channelId } = await channels.createChannel(asChat(creator), {
      type: 'private',
      name: 'strategy',
    });

    /* Rebuilt AFTER the channel exists. `createChannel` writes Alice's own
       membership tuple in the same transaction, and `creator` was built before
       that row existed — so reusing it here fails `channel:manage` and, because
       a caller who cannot read a private channel is told it does not exist,
       surfaces as NOT_FOUND on a channel that was just created successfully.
       The chat suite documents the same trap; it is the reason `actorFor` reads
       from the database every time rather than caching. */
    const alice = await actorFor(orgId, ALICE, 'owner');
    await channels.addChannelMember(asChat(alice), { channelId, userId: BOB });

    await withOrgScope(orgId, async (tx) => {
      await tx.insert(schema.relationshipTuples).values({
        id: unsafeAsId<'TupleId'>('0195ee13-0000-7000-8000-00000000f001'),
        orgId,
        subjectType: 'user',
        subjectId: CAROL,
        relation: 'viewer',
        objectType: 'channel',
        objectId: channelId,
        grantedBy: ALICE,
      });
    });

    const carol = await actorFor(orgId, CAROL);

    /* `message:create` — a viewer may read the conversation and may not speak in
       it, and making everyone's phone ring is speaking. */
    expect(
      await rejectionCode(() => sessions.startSession(carol, { channelId, kind: 'audio' })),
    ).toBe('FORBIDDEN');

    const started = await sessions.startSession(alice, { channelId, kind: 'audio' });
    /* ...and `channel:read` is enough to be IN it. */
    const view = await sessions.joinSession(carol, { sessionId: started.sessionId });
    expect(view.participants.find((p) => p.userId === CAROL)?.state).toBe('joined');
  });
});

/* -------------------------------------------------------------------------- *
 * §3.6 — first-answer-wins
 * -------------------------------------------------------------------------- */

describe('first-answer-wins', () => {
  it('promotes the session exactly once when two people answer at the same instant', async () => {
    const orgId = await newOrg('rtc-race');
    await seedMembers(orgId, [BOB, CAROL]);
    const channelId = await dmBetween(orgId, [ALICE, BOB, CAROL]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    const bob = await actorFor(orgId, BOB);
    const carol = await actorFor(orgId, CAROL);

    /* Genuinely concurrent, against real Postgres. A check-then-write would let
       both transactions read `ringing` and both write `active` — and both would
       emit `rtc_session.answered`, so anything counting conversations counts
       this call twice. The conditional UPDATE's returned row count is what makes
       exactly one of them the winner. */
    await Promise.all([
      sessions.joinSession(bob, { sessionId }),
      sessions.joinSession(carol, { sessionId }),
    ]);

    const answered = await withOrgScope(orgId, async (tx) =>
      tx
        .select({ name: schema.outbox.name })
        .from(schema.outbox)
        .where(eq(schema.outbox.name, 'rtc_session.answered')),
    );

    expect(answered).toHaveLength(1);

    const row = await sessionRow(orgId, sessionId);
    expect(row?.status).toBe('active');
    expect(row?.joinedCount).toBe(3);
  });

  it('does not let the INITIATOR answer their own call (§3.6 correction)', async () => {
    // The real web client joins the WebRTC mesh — and therefore calls this
    // same join route — the instant it PLACES a call, not only when someone
    // answers. Without excluding the initiator, that self-join reaches
    // Postgres before any human can react to a ring, and the caller's own
    // request wins first-answer-wins against their own callee.
    const orgId = await newOrg('rtc-self-join');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    // The caller's own client joining its own just-created session.
    const view = await sessions.joinSession(alice, { sessionId });
    expect(view.status).toBe('ringing');

    const row = await sessionRow(orgId, sessionId);
    expect(row?.status).toBe('ringing');
    expect(row?.startedAt).toBeNull();

    const answered = await withOrgScope(orgId, async (tx) =>
      tx
        .select({ name: schema.outbox.name })
        .from(schema.outbox)
        .where(eq(schema.outbox.name, 'rtc_session.answered')),
    );
    expect(answered).toHaveLength(0);

    // A real answer from the actual callee still works normally afterward.
    const bob = await actorFor(orgId, BOB);
    const answeredView = await sessions.joinSession(bob, { sessionId });
    expect(answeredView.status).toBe('active');
  });

  it('does not count a second join from the same person twice', async () => {
    const orgId = await newOrg('rtc-rejoin');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    const bob = await actorFor(orgId, BOB);
    await sessions.joinSession(bob, { sessionId });
    const second = await sessions.joinSession(bob, { sessionId });

    /* A second tab, or a retried request. The count is people in the call, not
       calls to this function — without the conditional participant claim, one
       person opening two tabs consumes two of the four mesh seats. */
    expect(second.joinedCount).toBe(2);
  });
});

/* -------------------------------------------------------------------------- *
 * §3.5 — the participant cap, enforced by the database
 * -------------------------------------------------------------------------- */

describe('the mesh participant cap', () => {
  it('refuses to start a call in a conversation bigger than the cap', async () => {
    const orgId = await newOrg('rtc-big');
    await seedMembers(orgId, [BOB, CAROL, DAVE, ERIN]);
    /* Five people — one over MESH_PARTICIPANT_CAP. */
    const channelId = await dmBetween(orgId, [ALICE, BOB, CAROL, DAVE, ERIN]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    expect(
      await rejectionCode(() => sessions.startSession(alice, { channelId, kind: 'audio' })),
    ).toBe('QUOTA_EXCEEDED');
  });

  it('is enforced by the CHECK constraint, not only by the service', async () => {
    const orgId = await newOrg('rtc-cap');
    await seedMembers(orgId, [BOB, CAROL, DAVE]);
    const channelId = await dmBetween(orgId, [ALICE, BOB, CAROL, DAVE]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    for (const userId of [BOB, CAROL, DAVE]) {
      await sessions.joinSession(await actorFor(orgId, userId), { sessionId });
    }

    const full = await sessionRow(orgId, sessionId);
    expect(full?.joinedCount).toBe(MESH_PARTICIPANT_CAP);

    /* ERIN is not on the ring list, but she is a member of the org — and this
       is a group DM she is not in, so she is refused by `can()` first. To reach
       the CHECK, the row has to be pushed past the cap directly: what is under
       test is the CONSTRAINT, and the service branch that translates its
       SQLSTATE into QUOTA_EXCEEDED is only meaningful if the constraint really
       fires. */
    await admin.setOrg(orgId);
    const violation = await admin
      .query(`UPDATE rtc.sessions SET joined_count = joined_count + 1 WHERE id = $1`, [sessionId])
      .then(() => null)
      .catch((error: unknown) => error);
    await admin.setOrg(null);

    expect(violation).not.toBeNull();
    expect(String(violation)).toMatch(/sessions_joined_within_cap/);
  });
});

/* -------------------------------------------------------------------------- *
 * Lifecycle
 * -------------------------------------------------------------------------- */

describe('session lifecycle', () => {
  it('refuses a second live call in the same conversation', async () => {
    const orgId = await newOrg('rtc-dup');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    await sessions.startSession(alice, { channelId, kind: 'audio' });

    /* `sessions_one_live_per_channel`. Two people pressing "call" in the same
       DM is the ordinary case, and without the partial unique index it produces
       two sessions that ring past each other — which presents to both of them
       as "the network dropped". */
    const bob = await actorFor(orgId, BOB);
    expect(
      await rejectionCode(() => sessions.startSession(bob, { channelId, kind: 'audio' })),
    ).toBe('CONFLICT');
  });

  it('ends a 1:1 call the moment EITHER party leaves, and frees the conversation', async () => {
    const orgId = await newOrg('rtc-empty');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
    await sessions.joinSession(bob, { sessionId });

    /* Only two people were ever part of this call, so Bob leaving is the
       whole call ending — Alice must not be left talking to nobody until she
       also clicks "leave". */
    await sessions.leaveSession(bob, { sessionId });

    const ended = await sessionRow(orgId, sessionId);
    expect(ended?.status).toBe('ended');
    expect(ended?.endReason).toBe('empty');

    /* A second leave from the party already gone is a no-op, not an error —
       `leaveSession` returns early once the session reads `ended`. */
    await sessions.leaveSession(alice, { sessionId });
    expect((await sessionRow(orgId, sessionId))?.status).toBe('ended');

    /* The live-session index is what would otherwise make a dead call block
       every future one in that conversation, forever. */
    const next = await sessions.startSession(alice, { channelId, kind: 'audio' });
    expect(next.sessionId).not.toBe(sessionId);
  });

  it('does NOT end a group call early when it drops to one person', async () => {
    const orgId = await newOrg('rtc-group-thin');
    await seedMembers(orgId, [BOB, CAROL]);
    const channelId = await dmBetween(orgId, [ALICE, BOB, CAROL]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const carol = await actorFor(orgId, CAROL);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
    await sessions.joinSession(bob, { sessionId });
    await sessions.joinSession(carol, { sessionId });

    /* Three people were ever part of this call, so one leaving is not the
       whole call ending — the remaining two are still on it. */
    await sessions.leaveSession(carol, { sessionId });
    expect((await sessionRow(orgId, sessionId))?.status).toBe('active');

    /* Down to Alice alone now — still not ended. A person left in a group
       call may be waiting for someone to rejoin, unlike a 1:1 call which has
       structurally nobody else it could ever reconnect to. */
    await sessions.leaveSession(bob, { sessionId });
    expect((await sessionRow(orgId, sessionId))?.status).toBe('active');

    await sessions.leaveSession(alice, { sessionId });
    expect((await sessionRow(orgId, sessionId))?.status).toBe('ended');
  });

  it('ends a ringing 1:1 call when the only invitee declines', async () => {
    const orgId = await newOrg('rtc-decline');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    await sessions.declineSession(bob, { sessionId });

    const ended = await sessionRow(orgId, sessionId);
    expect(ended?.status).toBe('ended');
    expect(ended?.endReason).toBe('declined');
  });

  it('ends a ringing 1:1 call on decline even after the CALLER has joined their own session', async () => {
    // This is the real client sequence, not the shortcut the test above
    // takes: `call-button.tsx` calls `joinCall()` — which hits this same
    // join route — for the caller too, immediately after `startSession`.
    // Before the initiator exclusion above, that self-join corrupted
    // `status` to 'active', which silently defeated `declineSession`'s
    // `status === 'ringing'` guard below — the callee's decline updated
    // their own participant row but never ended the session, so the
    // caller's screen never cleared.
    const orgId = await newOrg('rtc-decline-after-selfjoin');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
    await sessions.joinSession(alice, { sessionId });

    await sessions.declineSession(bob, { sessionId });

    const ended = await sessionRow(orgId, sessionId);
    expect(ended?.status).toBe('ended');
    expect(ended?.endReason).toBe('declined');
  });

  it('does not end an answered call when a second invitee declines', async () => {
    const orgId = await newOrg('rtc-late-decline');
    await seedMembers(orgId, [BOB, CAROL]);
    const channelId = await dmBetween(orgId, [ALICE, BOB, CAROL]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    await sessions.joinSession(await actorFor(orgId, BOB), { sessionId });
    await sessions.declineSession(await actorFor(orgId, CAROL), { sessionId });

    /* Declining after somebody picked up is one person opting out of a
       conversation that is happening. Ending it for everyone would be the
       caller hanging up on their own call by refusing it. */
    expect((await sessionRow(orgId, sessionId))?.status).toBe('active');
  });

  it('reports a ringing call to the person being rung, and nobody else', async () => {
    const orgId = await newOrg('rtc-incoming');
    await seedMembers(orgId, [BOB, OUTSIDER]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    expect(await sessions.incomingCalls(await actorFor(orgId, BOB))).toEqual([
      expect.objectContaining({ sessionId, initiatedBy: ALICE }),
    ]);

    /* Keyed on the caller's OWN participant rows, so it discloses nothing about
       conversations they are not part of. */
    expect(await sessions.incomingCalls(await actorFor(orgId, OUTSIDER))).toEqual([]);
    /* The initiator is `joined`, not `invited` — they are not ringing themselves. */
    expect(await sessions.incomingCalls(alice)).toEqual([]);
  });

  it('lets only the initiator cancel', async () => {
    const orgId = await newOrg('rtc-cancel');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });

    expect(await rejectionCode(() => sessions.cancelSession(bob, { sessionId }))).toBe('FORBIDDEN');

    await sessions.cancelSession(alice, { sessionId });
    const ended = await sessionRow(orgId, sessionId);
    expect(ended?.status).toBe('ended');
    expect(ended?.endReason).toBe('no_answer');
  });

  it('refuses to start a call in a public channel (Wave 1 scope, §6)', async () => {
    const orgId = await newOrg('rtc-public');
    await seedMembers(orgId, [BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const { channelId } = await channels.createChannel(asChat(alice), {
      type: 'public',
      name: 'general',
    });

    /* CONFLICT rather than FORBIDDEN: the caller is entitled to do this, the
       feature does not exist yet. Ringing every member of the org is not a
       smaller version of the right behaviour. */
    expect(
      await rejectionCode(() => sessions.startSession(alice, { channelId, kind: 'audio' })),
    ).toBe('CONFLICT');
  });
});

/* -------------------------------------------------------------------------- *
 * Removed from the org mid-call — the phantom-session gap
 * -------------------------------------------------------------------------- */

describe('removeMember cleans up an active call (tenancy/member.service.ts)', () => {
  it('ends a 1:1 call when the joined party is removed from the org mid-call', async () => {
    // The real failure mode this closes: the removed party's own client would
    // try to leave gracefully and be refused with NOT_A_MEMBER (correctly —
    // they are not one anymore), and that failure was silently swallowed —
    // leaving the session `active` forever with a party who can never speak
    // to anyone again in it.
    const orgId = await newOrg('rtc-evict-1on1');
    await seedMembers(orgId, [BOB]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
    await sessions.joinSession(bob, { sessionId });
    expect((await sessionRow(orgId, sessionId))?.status).toBe('active');

    await members.removeMember(orgId, { userId: BOB }, { userId: ALICE, requestId });

    const ended = await sessionRow(orgId, sessionId);
    expect(ended?.status).toBe('ended');
    expect(ended?.endReason).toBe('empty');

    /* The live-session index is freed too — the same proof `leaveSession`'s
       own test uses — otherwise a phantom session blocks every future call
       in the conversation. */
    const next = await sessions.startSession(alice, { channelId, kind: 'audio' });
    expect(next.sessionId).not.toBe(sessionId);
  });

  it('does not end a group call when the removed party was not the last leg', async () => {
    const orgId = await newOrg('rtc-evict-group');
    await seedMembers(orgId, [BOB, CAROL]);
    const channelId = await dmBetween(orgId, [ALICE, BOB, CAROL]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const carol = await actorFor(orgId, CAROL);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
    await sessions.joinSession(bob, { sessionId });
    await sessions.joinSession(carol, { sessionId });

    await members.removeMember(orgId, { userId: CAROL }, { userId: ALICE, requestId });

    const row = await sessionRow(orgId, sessionId);
    expect(row?.status).toBe('active');
    expect(row?.joinedCount).toBe(2);
  });

  it('does nothing to a call the removed party was never on', async () => {
    const orgId = await newOrg('rtc-evict-unrelated');
    await seedMembers(orgId, [BOB, CAROL]);
    const channelId = await dmBetween(orgId, [ALICE, BOB]);

    const alice = await actorFor(orgId, ALICE, 'owner');
    const bob = await actorFor(orgId, BOB);
    const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
    await sessions.joinSession(bob, { sessionId });

    // Carol is a member of the org but not part of this call at all.
    await members.removeMember(orgId, { userId: CAROL }, { userId: ALICE, requestId });

    expect((await sessionRow(orgId, sessionId))?.status).toBe('active');
  });
});
