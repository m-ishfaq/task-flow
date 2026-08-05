import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type ChannelId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { authorizeChannelJoin } from './rooms.js';

/**
 * Channel room authorization against real Postgres
 * (ai/phase-5-chat.md §3.3, §6.4).
 *
 * §6.4 names one test as non-optional: "a room-join test proving `can()` is
 * actually consulted for a DM channel specifically (not just a public one —
 * §3.3's point is that DMs are not a shortcut around `can()`)". That is
 * `describe('a DM channel')` below, and it is written as its own block rather
 * than as one more row in a table, because the failure it guards against is
 * precisely that DMs quietly acquire a second code path.
 *
 * ## What the interesting assertion actually is
 *
 * `denies an org member who is not a participant` is the one to read first. Every
 * member of an organization holds `channel:read` from the role matrix — they
 * hold it so they can read PUBLIC channels — so a `can()` target built without
 * `closed` answers ALLOWED for that case, with a decision trace that looks
 * entirely correct at every step. There is no error, no log line, and no failing
 * assertion anywhere else in this repository if that flag goes missing. This
 * test is the thing that fails.
 *
 * Real Postgres rather than a mock, for the reason `rooms.test.ts` gives: this
 * composes `resolveOrgMembership`, `loadChannel` and `can()` — the same
 * functions the HTTP path uses (§6.2) — and a stub would only prove the file
 * agrees with itself. Membership here is a relationship TUPLE, so the test also
 * covers that the tuple actually loads and reaches the engine, which is the
 * whole basis of §3.3's "no inline participant check".
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const ORG = unsafeAsId<'OrgId'>('0195ff00-0000-7000-8000-0000000000c1');

/** Two people in a conversation. */
const ALICE = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000c01');
const BOB = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000c02');
/** A perfectly ordinary member of the same org, in neither private space. */
const CAROL = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000c03');
/** An org ADMIN, also not a participant — the no-bypass case. */
const ADMIN = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000c04');
/** Holds no membership row in ORG at all. */
const STRANGER = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000c05');

const PUBLIC_CHANNEL = unsafeAsId<'ChannelId'>('0195ff00-0000-7000-8000-000000000c10');
const PRIVATE_CHANNEL = unsafeAsId<'ChannelId'>('0195ff00-0000-7000-8000-000000000c11');
const DM = unsafeAsId<'ChannelId'>('0195ff00-0000-7000-8000-000000000c12');
const NO_SUCH_CHANNEL = unsafeAsId<'ChannelId'>('0195ff00-0000-7000-8000-0000000000fc');

const ALL_USER_IDS = [ALICE, BOB, CAROL, ADMIN, STRANGER];

let admin: AdminConnection;

async function addChannel(
  channelId: ChannelId,
  type: string,
  name: string | null,
): Promise<void> {
  await admin.query(
    `INSERT INTO chat.channels (id, org_id, type, name) VALUES ($1, $2, $3, $4)`,
    [channelId, ORG, type, name],
  );
}

/**
 * Channel membership — a relationship tuple, not a table row.
 *
 * This is the whole mechanism (§3.3): being in a channel IS holding
 * (user, 'member', channel:{id}), which `resolveOrgMembership` loads onto the
 * subject and `can()` weighs. If a `chat.channel_members` table ever appears,
 * this helper is the thing that would have to change, which is a useful place
 * for that decision to become visible.
 */
async function addMember(channelId: ChannelId, userId: UserId): Promise<void> {
  await admin.query(
    `INSERT INTO authz.relationship_tuples
       (id, org_id, subject_type, subject_id, relation, object_type, object_id)
     VALUES (gen_random_uuid(), $1, 'user', $2, 'member', 'channel', $3)`,
    [ORG, userId, channelId],
  );
}

async function cleanup(): Promise<void> {
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM chat.messages WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM chat.channels WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [ALL_USER_IDS]);
}

beforeAll(async () => {
  await applyMigrations({ url: MIGRATION_URL });
  admin = await connectAsMigrator({ url: MIGRATION_URL });
  await cleanup();

  for (const [index, userId] of ALL_USER_IDS.entries()) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [userId, `chat-rooms-test-${String(index)}@example.test`],
    );
  }

  await admin.setOrg(ORG);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG,
    'Chat Rooms Test',
    'chat-rooms-test',
  ]);

  for (const [userId, role] of [
    [ALICE, 'member'],
    [BOB, 'member'],
    [CAROL, 'member'],
    [ADMIN, 'admin'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.memberships (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [ORG, userId, role],
    );
  }

  await addChannel(PUBLIC_CHANNEL, 'public', 'general');
  await addChannel(PRIVATE_CHANNEL, 'private', 'leadership');
  await addChannel(DM, 'dm', null);

  await addMember(PRIVATE_CHANNEL, ALICE);
  await addMember(DM, ALICE);
  await addMember(DM, BOB);

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-realtime-chat-rooms-test' });
});

afterAll(async () => {
  await closeDatabase();
  await cleanup();
  await admin.end();
});

describe('a public channel', () => {
  it('admits any org member, with no tuple needed', async () => {
    // This is what `channel:read` in the member role is FOR. If this fails, the
    // closed-resource change has over-reached and made every channel private.
    const result = await authorizeChannelJoin(CAROL, ORG, PUBLIC_CHANNEL);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('granted');
  });

  it('refuses someone with no membership in the org', async () => {
    const result = await authorizeChannelJoin(STRANGER, ORG, PUBLIC_CHANNEL);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_a_member');
    // No decision was reached: the caller never got far enough for can() to run,
    // and a fabricated one here would be distinguishable from a real denial.
    expect(result.decision).toBeUndefined();
  });
});

describe('a private channel', () => {
  it('admits a member holding the tuple', async () => {
    const result = await authorizeChannelJoin(ALICE, ORG, PRIVATE_CHANNEL);
    expect(result.allowed).toBe(true);
  });

  it('denies an org member who holds no tuple', async () => {
    const result = await authorizeChannelJoin(CAROL, ORG, PRIVATE_CHANNEL);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('denied');
    expect(result.decision?.allowed).toBe(false);
  });
});

/**
 * The §6.4 mandated block.
 *
 * A DM is a `channels` row with `type = 'dm'` and no name. Nothing in
 * `authorizeChannelJoin` branches on that — it loads the row, builds a target,
 * and asks `can()`, exactly as it does for a public channel. These tests exist
 * to prove that the ABSENCE of a special case produces the right answers, so
 * that adding one later has to break something.
 */
describe('a DM channel', () => {
  it('admits each participant', async () => {
    expect((await authorizeChannelJoin(ALICE, ORG, DM)).allowed).toBe(true);
    expect((await authorizeChannelJoin(BOB, ORG, DM)).allowed).toBe(true);
  });

  it('denies an org member who is not a participant', async () => {
    /* THE test. Carol is an ordinary member in good standing, and her role
       grants `channel:read` — she needs it for #general. Without `closed` on
       the target this returns allowed, and every direct message in the
       organization is readable by everyone in it, silently. */
    const result = await authorizeChannelJoin(CAROL, ORG, DM);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('denied');
  });

  it('denies an org ADMIN who is not a participant', async () => {
    /* Admins bypass restrictive CAPS (`bypassesRestrictions` in roles.ts) on the
       reasoning that they could delete the tuple anyway. That reasoning does not
       extend to a DM: there is no membership an admin could grant themselves,
       and reading someone's conversation is invisible to them in a way that
       joining a channel is not. Compliance export (Wave 4) is the audited path. */
    const result = await authorizeChannelJoin(ADMIN, ORG, DM);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('denied');
  });

  it('reaches the decision through can(), not through a membership lookup', async () => {
    /* §3.3 forbids `participantIds.includes(userId)` on this path. A short-circuit
       of that kind would return the right boolean with no decision attached —
       there would be nothing for `can()` to have produced. Asserting the TRACE
       exists is how this test can tell "denied by the policy engine" apart from
       "denied by an if-statement that happened to agree with it". */
    const result = await authorizeChannelJoin(CAROL, ORG, DM);

    expect(result.decision).toBeDefined();
    expect(result.decision?.permission).toBe('channel:read');
    expect(result.decision?.trace.some((step) => step.outcome === 'deny')).toBe(true);
  });
});

describe('a channel that cannot be reached', () => {
  it('refuses an id that does not exist', async () => {
    const result = await authorizeChannelJoin(ALICE, ORG, NO_SUCH_CHANNEL);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_such_channel');
  });
});
