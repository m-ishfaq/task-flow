import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type BoardId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { authorizeJoin } from './rooms.js';

/**
 * Room authorization against real Postgres (ai/phase-4-realtime.md §3.3, §6.4).
 *
 * §6.4 names one test as non-optional: a socket presenting a VALID token for
 * user A, attempting to join a room naming a board A has no membership on,
 * must be refused — "as its own named test, not folded into a general
 * 'authorization works' case that could pass while this one path regressed."
 * That is `it('refuses a user who holds no membership in the room's org')`
 * below. §3.7 means there is no field to name a DIFFERENT user's id in — the
 * join request schema is asserted separately, in wire.test.ts — so the
 * property this suite can exercise directly is the half that lives in
 * `authorizeJoin`: a caller can supply any `(userId, orgId, boardId)` and the
 * function must answer correctly for every combination, not just the happy one.
 *
 * `authorizeJoin` composes `resolveOrgMembership`, `loadBoard` and `can()` —
 * the exact functions the HTTP path uses (§6.2) — so a mock would only prove
 * this file agrees with a stub of those functions. What matters is whether RLS
 * and the real policy engine, exercised through this module's own call shape,
 * produce the decision §3.3 describes.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const ORG = unsafeAsId<'OrgId'>('0195ff00-0000-7000-8000-0000000000a1');
const OTHER_ORG = unsafeAsId<'OrgId'>('0195ff00-0000-7000-8000-0000000000b1');

const OWNER = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000a01');
/** A real member of ORG, but `guest` holds no permissions of its own (roles.ts). */
const GUEST = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000a02');
/** Holds NO membership row in ORG at all — the §6.4 mandated case. */
const STRANGER = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000a03');
const OTHER_ORG_OWNER = unsafeAsId<'UserId'>('0195ff00-0000-7000-8000-000000000b01');

const PROJECT = '0195ff00-0000-7000-8000-000000000a10';
const BOARD = unsafeAsId<'BoardId'>('0195ff00-0000-7000-8000-000000000a11');
const NO_SUCH_BOARD = unsafeAsId<'BoardId'>('0195ff00-0000-7000-8000-0000000000ff');

const OTHER_PROJECT = '0195ff00-0000-7000-8000-000000000b10';
/** A real board — just not in ORG. */
const OTHER_ORG_BOARD = unsafeAsId<'BoardId'>('0195ff00-0000-7000-8000-000000000b11');

const ALL_ORG_IDS = [ORG, OTHER_ORG];
const ALL_USER_IDS = [OWNER, GUEST, STRANGER, OTHER_ORG_OWNER];

let admin: AdminConnection;

async function seedOrg(
  orgId: OrgId,
  slug: string,
  ownerId: UserId,
  extraMembers: readonly { userId: UserId; role: string }[],
  projectId: string,
  boardId: BoardId,
): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Rooms Test ${slug}`,
    `rooms-test-${slug}`,
  ]);

  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [orgId, ownerId],
  );

  for (const member of extraMembers) {
    await admin.query(
      `INSERT INTO identity.memberships (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgId, member.userId, member.role],
    );
  }

  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, 'Rooms Project', $3)`,
    [projectId, orgId, `ROOM${slug.toUpperCase()}`],
  );

  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank)
     VALUES ($1, $2, $3, 'Rooms Board', 'a0')`,
    [boardId, orgId, projectId],
  );
}

async function cleanup(): Promise<void> {
  for (const orgId of ALL_ORG_IDS) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  }
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
      [userId, `rooms-test-${String(index)}@example.test`],
    );
  }

  await seedOrg(ORG, 'a', OWNER, [{ userId: GUEST, role: 'guest' }], PROJECT, BOARD);
  await seedOrg(OTHER_ORG, 'b', OTHER_ORG_OWNER, [], OTHER_PROJECT, OTHER_ORG_BOARD);

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-realtime-rooms-test' });
});

afterAll(async () => {
  await closeDatabase();
  await cleanup();
  await admin.end();
});

describe('authorizeJoin', () => {
  it('grants a member whose role holds board:read', async () => {
    const result = await authorizeJoin(OWNER, ORG, BOARD);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('granted');
    expect(result.decision?.allowed).toBe(true);
  });

  it('denies a member whose role holds no permissions of its own', async () => {
    // `guest` (packages/policy/src/roles.ts) grants nothing by role — access
    // comes only from relationship tuples, and this member has none. This is
    // the ONE case that reaches can() and is refused by it, distinct from
    // being refused earlier for having no membership at all.
    const result = await authorizeJoin(GUEST, ORG, BOARD);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('denied');
    expect(result.decision?.allowed).toBe(false);
  });

  /**
   * The §6.4 mandated test, written as its own case rather than folded into
   * the ones above: a valid caller, naming a board they hold no membership on
   * in the room's org, must be refused — and refused for exactly this reason,
   * not a coincidentally-identical one. If this regressed to `allowed: true`,
   * or even to the right boolean for the wrong reason, this is the test that
   * would catch it.
   */
  it('refuses a user who holds no membership in the room’s org', async () => {
    const result = await authorizeJoin(STRANGER, ORG, BOARD);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_a_member');
    // No decision was reached — the caller never got far enough for can() to
    // run, and JoinAuthorization documents that absence as meaningful: this
    // must not carry a fabricated decision an attacker could distinguish from
    // a real "denied" one.
    expect(result.decision).toBeUndefined();
  });

  it('refuses a board id that does not exist', async () => {
    const result = await authorizeJoin(OWNER, ORG, NO_SUCH_BOARD);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_such_board');
  });

  it('refuses a real board id that belongs to a DIFFERENT org', async () => {
    // OWNER is a genuine member of ORG — this is not the not_a_member case.
    // OTHER_ORG_BOARD is a real row, just not one `withOrgScope(ORG, ...)` can
    // see. RLS is what turns "wrong org" into "no such board" rather than a
    // service-level check catching it — the same property guardrail 8's fuzz
    // harness exists to prove for the HTTP routes, exercised here for the one
    // path that is not an HTTP route.
    const result = await authorizeJoin(OWNER, ORG, OTHER_ORG_BOARD);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_such_board');
  });
});
