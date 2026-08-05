import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@taskflow/observability';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { applyRevocation } from './revocation.js';
import type { GatewayServer, GatewaySocket } from './socket-data.js';
import { boardIdOfRoom } from './wire.js';

/**
 * The re-check half of §7.2, against real Postgres (§3.3, §5, §6.4).
 *
 * `revocation.test.ts` covers the two paths that need no database — a session
 * revocation disconnects, a `member.removed` leaves that org's rooms — because
 * neither consults `can()`. This file covers the one that does, and it is the
 * one Wave 1's acceptance criteria name outright:
 *
 *   "A tab whose `viewer` tuple gets revoked mid-session is force-left within
 *    one tick of the `grant.revoked` event."
 *
 * A mock cannot demonstrate that. The whole claim is that `recheck` calls the
 * SAME `authorizeJoin` a join called, so that a membership change made through
 * ordinary means — a row deleted from `authz.relationship_tuples` — actually
 * changes the answer. Stubbing `authorizeJoin` would assert only that this file
 * agrees with its own stub about what revocation means, which is exactly the
 * "two models that drift" failure §6.2 exists to prevent.
 *
 * So the subject here is a `guest`: a role that grants nothing on its own
 * (`packages/policy/src/roles.ts`), whose access to the board comes ENTIRELY
 * from a `viewer` tuple. Delete the tuple and the same call that granted the
 * join now refuses it — with no test-only seam anywhere in the path.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const ORG = unsafeAsId<'OrgId'>('0195ff01-0000-7000-8000-0000000000a1');
const OTHER_ORG = unsafeAsId<'OrgId'>('0195ff01-0000-7000-8000-0000000000b1');

/** Access comes only from the tuple — `guest` grants nothing by role. */
const GUEST = unsafeAsId<'UserId'>('0195ff01-0000-7000-8000-000000000a02');
const OWNER = unsafeAsId<'UserId'>('0195ff01-0000-7000-8000-000000000a01');

const PROJECT = '0195ff01-0000-7000-8000-000000000a10';
const BOARD = '0195ff01-0000-7000-8000-000000000a11';

const OTHER_PROJECT = '0195ff01-0000-7000-8000-000000000b10';
const OTHER_BOARD = '0195ff01-0000-7000-8000-000000000b11';

const TUPLE = '0195ff01-0000-7000-8000-000000000c01';
const OTHER_TUPLE = '0195ff01-0000-7000-8000-000000000c02';

const ALL_ORG_IDS = [ORG, OTHER_ORG];
const ALL_USER_IDS = [OWNER, GUEST];

const logger = createLogger({ name: 'revocation-recheck-test', level: 'silent' });

let admin: AdminConnection;

/** Records what `applyRevocation` did to one socket. Mirrors `revocation.test.ts`. */
function fakeSocket(userId: UserId, sessionId: string, rooms: [string, OrgId][]) {
  const emitted: { event: string; payload: unknown }[] = [];
  const left: string[] = [];
  let disconnected = false;

  const socket = {
    data: { identity: { userId, sessionId }, rooms: new Map(rooms), address: '127.0.0.1' },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
    leave: (room: string) => {
      left.push(room);
    },
    disconnect: () => {
      disconnected = true;
    },
  };

  return {
    socket: socket as unknown as GatewaySocket,
    emitted,
    left,
    isDisconnected: () => disconnected,
  };
}

function fakeIo(sockets: GatewaySocket[]): GatewayServer {
  return {
    sockets: { sockets: new Map(sockets.map((socket, index) => [String(index), socket])) },
    in: (room: string) => ({
      fetchSockets: () =>
        Promise.resolve(
          sockets
            .filter((socket) => socket.data.rooms.has(boardIdOfRoom(room) ?? ''))
            .map((socket) => ({ data: socket.data })),
        ),
    }),
    to: () => ({ emit: () => undefined }),
  } as unknown as GatewayServer;
}

async function seedOrg(
  orgId: OrgId,
  slug: string,
  projectId: string,
  boardId: string,
): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Recheck ${slug}`,
    `recheck-${slug}`,
  ]);
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, 'Recheck', $3)`,
    [projectId, orgId, `RCK${slug.toUpperCase()}`],
  );
  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank)
     VALUES ($1, $2, $3, 'Recheck Board', 'a0')`,
    [boardId, orgId, projectId],
  );
}

/** Grants `userId` a `viewer` tuple on `boardId`. The only thing a guest has. */
async function grantViewer(
  tupleId: string,
  orgId: OrgId,
  userId: UserId,
  boardId: string,
): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO authz.relationship_tuples
       (id, org_id, subject_type, subject_id, relation, object_type, object_id)
     VALUES ($1, $2, 'user', $3, 'viewer', 'board', $4)
     ON CONFLICT (id) DO NOTHING`,
    [tupleId, orgId, userId, boardId],
  );
}

async function revokeTuple(orgId: OrgId, tupleId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE id = $1`, [tupleId]);
}

async function cleanup(): Promise<void> {
  for (const orgId of ALL_ORG_IDS) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
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
      [userId, `recheck-${String(index)}@example.test`],
    );
  }

  await seedOrg(ORG, 'a', PROJECT, BOARD);
  await seedOrg(OTHER_ORG, 'b', OTHER_PROJECT, OTHER_BOARD);

  await admin.setOrg(ORG);
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [ORG, OWNER],
  );
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'guest')`,
    [ORG, GUEST],
  );

  // The guest is also a member of the OTHER org, with a board there, so the
  // "only the affected org's rooms" property has something to be wrong about.
  await admin.setOrg(OTHER_ORG);
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'guest')`,
    [OTHER_ORG, GUEST],
  );

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-realtime-recheck-test' });
});

afterAll(async () => {
  await closeDatabase();
  await cleanup();
  await admin.end();
});

beforeEach(async () => {
  // Both tuples restored before each case, so a test that revokes one cannot
  // change whether the next test starts from "access granted".
  await grantViewer(TUPLE, ORG, GUEST, BOARD);
  await grantViewer(OTHER_TUPLE, OTHER_ORG, GUEST, OTHER_BOARD);
});

describe('applyRevocation — the re-check path (§3.3, §7.2)', () => {
  it('leaves a socket alone when the re-check still passes', async () => {
    // The control case, and the one that makes the next test meaningful: a
    // revocation event for this user fires, `can()` is genuinely consulted
    // against real rows, and the answer is still yes. A `recheck` that dropped
    // every room unconditionally would pass the force-leave test below and
    // fail here.
    const held = fakeSocket(GUEST, 'sess-1', [[BOARD, ORG]]);

    await applyRevocation(
      fakeIo([held.socket]),
      { kind: 'recheck_user', orgId: ORG, userId: GUEST },
      logger,
    );

    expect(held.left).toEqual([]);
    expect(held.emitted).toEqual([]);
    expect(held.socket.data.rooms.has(BOARD)).toBe(true);
  });

  /**
   * Wave 1's stated acceptance criterion, as an assertion: a tab whose `viewer`
   * tuple is revoked mid-session is force-left the room.
   *
   * Note what is NOT asserted: a disconnect. §7.2's split is the point — a
   * revoked share must cost the user that room and nothing else.
   */
  it('force-leaves the room when a viewer tuple is revoked mid-session', async () => {
    const held = fakeSocket(GUEST, 'sess-1', [[BOARD, ORG]]);

    await revokeTuple(ORG, TUPLE);

    await applyRevocation(
      fakeIo([held.socket]),
      { kind: 'recheck_user', orgId: ORG, userId: GUEST },
      logger,
    );

    expect(held.left).toEqual([`board:${BOARD}`]);
    expect(held.emitted).toEqual([{ event: 'room:closed', payload: { boardId: BOARD } }]);
    expect(held.socket.data.rooms.has(BOARD)).toBe(false);
    // The credential is untouched — only this room's access changed.
    expect(held.isDisconnected()).toBe(false);
  });

  it('leaves rooms in OTHER orgs untouched when one org’s grant is revoked', async () => {
    // The failure this rules out: a re-check that iterated every room rather
    // than the ones held in the affected org. Revoking one share would then
    // read as an outage across every board the user had open.
    const held = fakeSocket(GUEST, 'sess-1', [
      [BOARD, ORG],
      [OTHER_BOARD, OTHER_ORG],
    ]);

    await revokeTuple(ORG, TUPLE);

    await applyRevocation(
      fakeIo([held.socket]),
      { kind: 'recheck_user', orgId: ORG, userId: GUEST },
      logger,
    );

    expect(held.left).toEqual([`board:${BOARD}`]);
    expect(held.socket.data.rooms.has(OTHER_BOARD)).toBe(true);
  });

  it('re-checks a DIFFERENT user’s socket only under recheck_org, never recheck_user', async () => {
    // A team grant cannot be reduced to one user (`revocationOf`), so it
    // becomes an org-wide re-check. This asserts the two kinds actually differ:
    // the guest's socket must survive a recheck_user naming somebody else, and
    // must be re-evaluated under recheck_org.
    await revokeTuple(ORG, TUPLE);

    const underUserRecheck = fakeSocket(GUEST, 'sess-1', [[BOARD, ORG]]);
    await applyRevocation(
      fakeIo([underUserRecheck.socket]),
      { kind: 'recheck_user', orgId: ORG, userId: OWNER },
      logger,
    );
    expect(underUserRecheck.left).toEqual([]);

    const underOrgRecheck = fakeSocket(GUEST, 'sess-2', [[BOARD, ORG]]);
    await applyRevocation(
      fakeIo([underOrgRecheck.socket]),
      { kind: 'recheck_org', orgId: ORG },
      logger,
    );
    expect(underOrgRecheck.left).toEqual([`board:${BOARD}`]);
  });

  it('keeps a member whose ROLE grants access when someone else’s tuple is revoked', async () => {
    // The owner's access never came from a tuple, so an org-wide re-check must
    // not evict them. A `recheck` that treated "no tuple" as "no access" would
    // clear every board on the instance the moment any grant changed.
    await revokeTuple(ORG, TUPLE);

    const owner = fakeSocket(OWNER, 'sess-owner', [[BOARD, ORG]]);
    const guest = fakeSocket(GUEST, 'sess-guest', [[BOARD, ORG]]);

    await applyRevocation(
      fakeIo([owner.socket, guest.socket]),
      { kind: 'recheck_org', orgId: ORG },
      logger,
    );

    expect(owner.left).toEqual([]);
    expect(owner.socket.data.rooms.has(BOARD)).toBe(true);
    expect(guest.left).toEqual([`board:${BOARD}`]);
  });
});
