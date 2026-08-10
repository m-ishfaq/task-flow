import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { mintTurnCredential, newId, type MintTurnCredentialOptions } from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as channels from '../chat/channel.service.js';
import type { ChatActor } from '../chat/shared.js';
import * as sessions from './session.service.js';
import { issueIceServers } from './turn.service.js';
import type { RtcDeps } from './deps.js';
import type { RtcActor } from './shared.js';

/**
 * The TURN gate (ai/phase-13-webrtc.md §3.4).
 *
 * ## THE ASSERTION THAT MATTERS IS NOT THAT A REFUSAL IS RETURNED
 *
 * §3.4 sets the same acceptance bar Phase 7 Wave 1 set for the spend gate: **the
 * secret was never used.** A gate that answers `{ allowed: false }` after having
 * already minted reads perfectly in a diff and hands out a working credential to
 * somebody it just refused.
 *
 * So `minter.calls` — a recording stand-in in place of `mintTurnCredential` — is
 * checked on every refusal path below, and it is the only assertion in this file
 * that could not be satisfied by a gate that is wrong in exactly the way that
 * matters. The real primitive has its own suite in `packages/security`.
 *
 * Real Postgres because the durable issuance budget IS a rolling-window count
 * over a table under RLS, and a mocked version would prove the mock agrees with
 * itself.
 *
 * ⚠ Fixture prefix `0195ee14`, used by no other suite — see
 * `session.service.test.ts`'s note on why that matters.
 */

const ALICE = unsafeAsId<'UserId'>('0195ee14-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195ee14-0000-7000-8000-000000000002');
const OUTSIDER = unsafeAsId<'UserId'>('0195ee14-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [ALICE, 'alice@turn.test'],
  [BOB, 'bob@turn.test'],
  [OUTSIDER, 'outsider@turn.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee14-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

/**
 * A stand-in for `mintTurnCredential` that RECORDS every call.
 *
 * Delegates to the real primitive rather than returning a fixture, so a test
 * that asserts on the credential's shape is asserting on the real one — the
 * recording is the only thing added.
 */
class RecordingMinter {
  readonly calls: MintTurnCredentialOptions[] = [];

  readonly mint = (options: MintTurnCredentialOptions) => {
    this.calls.push(options);
    return mintTurnCredential(options);
  };
}

let minter: RecordingMinter;

function depsWithTurn(overrides: Partial<RtcDeps> = {}): RtcDeps {
  return {
    /* No storage. This suite is about the TURN gate, and an instance with no
       recordings bucket is a valid deployment — see `buildRtcDeps`. */
    storage: undefined,
    maxRecordingBytes: 64 * 1024 * 1024,
    stunUrls: ['stun:localhost:3478'],
    turnUrls: ['turn:localhost:3478?transport=udp'],
    turnSecret: 'coturn-test-secret',
    turnTtlSeconds: 600,
    turnIssuanceCapPerDay: 3,
    iceTransportPolicy: 'all',
    mint: minter.mint,
    ...overrides,
  };
}

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

/** Adds everyone but Alice (the org's owner, who created it) as members. */
async function seedMembers(orgId: OrgId, userIds: readonly UserId[]): Promise<void> {
  for (const userId of userIds) {
    const email = USERS.find(([id]) => id === userId)?.[1];
    if (email === undefined) throw new Error(`No fixture email for ${userId}.`);
    await members.addMember(orgId, { email, role: 'member' }, { userId: ALICE, requestId });
  }
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
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

/**
 * Suspends an org through the admin connection.
 *
 * `setOrg` before the UPDATE is REQUIRED, not tidiness: the migrator connection
 * is subject to FORCE RLS like everything else, so an update to `identity.orgs`
 * with no `app.org_id` set matches zero rows and reports success. Same trap
 * `spend-gate.test.ts` documents.
 */
async function suspendOrg(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  const result = await admin.query(`UPDATE identity.orgs SET status = 'suspended' WHERE id = $1`, [
    orgId,
  ]);
  if (result.rowCount !== 1) {
    throw new Error(`Expected to suspend exactly one org, updated ${String(result.rowCount)}.`);
  }
  await admin.setOrg(null);
}

/**
 * A live call between Alice and Bob, with both joined.
 *
 * The actor is rebuilt AFTER the DM exists, and that is not tidiness:
 * `openDirectMessage` writes both participants' membership tuples, and an actor
 * built before them carries the old answer — so `startSession` would be refused
 * on a conversation the same caller just created. `actorFor` reads from the
 * database every time for exactly this reason.
 */
async function liveCall(orgId: OrgId): Promise<string> {
  const creator = await actorFor(orgId, ALICE, 'owner');
  const { channelId } = await channels.openDirectMessage(asChat(creator), { userIds: [BOB] });

  const alice = await actorFor(orgId, ALICE, 'owner');
  const { sessionId } = await sessions.startSession(alice, { channelId, kind: 'audio' });
  await sessions.joinSession(await actorFor(orgId, BOB), { sessionId });
  return sessionId;
}

async function issuanceCount(orgId: OrgId): Promise<number> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx.select({ id: schema.rtcTurnIssuance.id }).from(schema.rtcTurnIssuance);
    return rows.length;
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-turn-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
  minter = new RecordingMinter();
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

describe('issueIceServers', () => {
  it('mints for a participant in a live call, and records the issuance', async () => {
    const orgId = await newOrg('turn-happy');
    await seedMembers(orgId, [BOB]);
    const sessionId = await liveCall(orgId);

    const config = await issueIceServers(await actorFor(orgId, BOB), depsWithTurn(), { sessionId });

    expect(minter.calls).toHaveLength(1);
    /* The SESSION id, never the user id. coturn logs the username on every
       allocation, and TURN logs are operational data with a different audience
       and retention from this database. */
    expect(minter.calls[0]?.identity).toBe(sessionId);

    const relay = config.iceServers.find((server) => server.credential !== undefined);
    expect(relay?.username).toMatch(new RegExp(`^\\d+:${sessionId}$`));
    expect(config.expiresAt).toBeInstanceOf(Date);

    expect(await issuanceCount(orgId)).toBe(1);
  });

  it('never touches the secret for a caller who cannot read the channel', async () => {
    const orgId = await newOrg('turn-outsider');
    await seedMembers(orgId, [BOB, OUTSIDER]);
    const sessionId = await liveCall(orgId);

    /* NOT_FOUND rather than FORBIDDEN, and that is `enforce()` working as
       designed (§8.7): someone who cannot read the DM is told it does not
       exist, because a 403 on a session id would confirm that two specific
       people are on a call. */
    const outsider = await actorFor(orgId, OUTSIDER);
    expect(
      await rejectionCode(() => issueIceServers(outsider, depsWithTurn(), { sessionId })),
    ).toBe('NOT_FOUND');

    /* THE assertion. Authorization is checked before anything else, so a caller
       probing session ids cannot mint — and, just as importantly, cannot burn a
       real org's daily allowance with requests that were always going to be
       refused. */
    expect(minter.calls).toHaveLength(0);
    expect(await issuanceCount(orgId)).toBe(0);
  });

  it('never touches the secret for a member of the channel who is not in the call', async () => {
    const orgId = await newOrg('turn-not-in-call');
    await seedMembers(orgId, [BOB]);

    const creator = await actorFor(orgId, ALICE, 'owner');
    const { channelId } = await channels.openDirectMessage(asChat(creator), { userIds: [BOB] });
    /* Rebuilt after the DM exists — see `liveCall`'s header. */
    const owner = await actorFor(orgId, ALICE, 'owner');
    const { sessionId } = await sessions.startSession(owner, { channelId, kind: 'audio' });

    /* Bob CAN read the channel — `can()` allows him, and he could join. He has
       not, so no bandwidth is spent on him. Two questions, deliberately not
       merged: authorization says who may be in the conversation, the spend gate
       says who gets relayed. */
    const bob = await actorFor(orgId, BOB);
    await sessions.declineSession(bob, { sessionId });

    expect(
      await rejectionCode(() => issueIceServers(bob, depsWithTurn(), { sessionId })),
    ).toBe('FORBIDDEN');

    expect(minter.calls).toHaveLength(0);
  });

  it('never touches the secret for a suspended org', async () => {
    const orgId = await newOrg('turn-suspended');
    await seedMembers(orgId, [BOB]);
    const sessionId = await liveCall(orgId);

    const bob = await actorFor(orgId, BOB);
    await suspendOrg(orgId);

    expect(await rejectionCode(() => issueIceServers(bob, depsWithTurn(), { sessionId }))).toBe(
      'ORG_SUSPENDED',
    );

    expect(minter.calls).toHaveLength(0);
    expect(await issuanceCount(orgId)).toBe(0);
  });

  it('never touches the secret once the daily issuance budget is spent', async () => {
    const orgId = await newOrg('turn-cap');
    await seedMembers(orgId, [BOB]);
    const sessionId = await liveCall(orgId);

    const deps = depsWithTurn({ turnIssuanceCapPerDay: 2 });
    const bob = await actorFor(orgId, BOB);

    await issueIceServers(bob, deps, { sessionId });
    await issueIceServers(bob, deps, { sessionId });

    expect(minter.calls).toHaveLength(2);

    /* `>=` rather than `>`: at exactly the cap the budget is spent. `>` would
       make the cap a line the org steps over exactly once. */
    expect(await rejectionCode(() => issueIceServers(bob, deps, { sessionId }))).toBe(
      'QUOTA_EXCEEDED',
    );

    expect(minter.calls).toHaveLength(2);
    expect(await issuanceCount(orgId)).toBe(2);
  });

  it('counts only issuances inside the rolling window', async () => {
    const orgId = await newOrg('turn-window');
    await seedMembers(orgId, [BOB]);
    const sessionId = await liveCall(orgId);

    /* Two issuances from yesterday. A budget that counted an org's whole
       history would refuse forever once the number was reached — a cap that
       never resets is an outage with a delayed fuse. */
    await withOrgScope(orgId, async (tx) => {
      for (let index = 0; index < 2; index += 1) {
        await tx.insert(schema.rtcTurnIssuance).values({
          id: newId<'TurnIssuanceId'>(),
          orgId,
          sessionId,
          userId: BOB,
          ttlSeconds: 600,
          issuedAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
        });
      }
    });

    const deps = depsWithTurn({ turnIssuanceCapPerDay: 2 });
    await issueIceServers(await actorFor(orgId, BOB), deps, { sessionId });

    expect(minter.calls).toHaveLength(1);
  });

  it('answers with STUN alone, and mints nothing, when no relay is configured', async () => {
    const orgId = await newOrg('turn-none');
    await seedMembers(orgId, [BOB]);
    const sessionId = await liveCall(orgId);

    /* A valid deployment (§5): STUN alone connects on most networks. Answering
       with what exists rather than erroring is the honest behaviour — and the
       env schema has already refused to boot on the half-configured case that
       would otherwise fail silently here. */
    const config = await issueIceServers(
      await actorFor(orgId, BOB),
      depsWithTurn({ turnUrls: [], turnSecret: undefined }),
      { sessionId },
    );

    expect(config.iceServers).toEqual([{ urls: ['stun:localhost:3478'] }]);
    expect(config.expiresAt).toBeNull();
    expect(minter.calls).toHaveLength(0);
    /* No relay means no bandwidth, so nothing is charged against the budget. */
    expect(await issuanceCount(orgId)).toBe(0);
  });
});
