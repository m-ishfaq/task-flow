import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import {
  appendToOutbox,
  closeDatabase,
  initializeDatabase,
  initializeRealtimeDatabase,
  withOrgScope,
  type OrgId,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createLogger } from '@taskflow/observability';
import { signAccessToken } from '@taskflow/security';
import { generateTestAccessTokenKeyPair } from '@taskflow/security/testing';
import { unsafeAsId, type UserId } from '@taskflow/contracts';
import type { DomainEvent } from '@taskflow/events';
import { buildGateway, type Gateway } from './gateway.js';
import type { Env } from './config/env.js';

/**
 * Wave 1's acceptance criteria, end to end (ai/phase-4-realtime.md §5).
 *
 * ## Why this exists as a test rather than a manual smoke check
 *
 * Every other suite in this app tests one seam: `rooms.test.ts` the
 * authorization decision, `relay.test.ts` the drain, `auth.test.ts` the
 * handshake, `wire.test.ts` the protocol's shape. `gateway.ts` is the file that
 * connects them, and until this suite it had no coverage at all — the wiring was
 * verified once, by hand, against a running process. That is a check that passes
 * exactly once and then silently stops being true.
 *
 * So this boots the REAL gateway on a real port, connects REAL socket.io
 * clients holding REAL access tokens, writes a REAL outbox row through
 * `appendToOutbox`, and asserts what each client actually received. Nothing here
 * is faked except the port number.
 *
 * §5's acceptance list, as assertions:
 *
 *   "a card dragged in one appears in the other without a refresh"
 *       → 'delivers a broadcast to every client in the board's room'
 *   "A tab on a DIFFERENT board's room never receives it"
 *       → 'does not deliver a board's events to a client in another room'
 *   "a join request naming a board that user has no membership on is refused"
 *       → 'refuses a join for a board the caller has no membership on'
 *   "A connection presenting no token ... never reaches `connection` at all"
 *       → 'refuses a handshake with no token' / '... with a disallowed origin'
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const REALTIME_URL =
  process.env['TEST_DATABASE_REALTIME_URL'] ??
  'postgresql://taskflow_realtime:realtime-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const PORT = 3477;
const ORIGIN = 'http://localhost:5173';
const { privateKey: JWT_PRIVATE_KEY, publicKey: JWT_PUBLIC_KEY } =
  await generateTestAccessTokenKeyPair();

const ORG = unsafeAsId<'OrgId'>('0195ff02-0000-7000-8000-0000000000a1');
const MEMBER = unsafeAsId<'UserId'>('0195ff02-0000-7000-8000-000000000a01');
/** A real, verifiable user who belongs to no org here — §5's refused-join case. */
const OUTSIDER = unsafeAsId<'UserId'>('0195ff02-0000-7000-8000-000000000a02');

const PROJECT = '0195ff02-0000-7000-8000-000000000a10';
const BOARD_A = '0195ff02-0000-7000-8000-000000000a11';
const BOARD_B = '0195ff02-0000-7000-8000-000000000a12';

const ALL_USER_IDS = [MEMBER, OUTSIDER];

const logger = createLogger({ name: 'gateway-integration-test', level: 'silent' });

/**
 * A poll interval short enough that a failure is a failure rather than a
 * timeout, but still a POLL — the LISTEN/NOTIFY wake-up (§7.3) is what actually
 * delivers these in practice, and leaving the poll enabled means this suite
 * passes on either path rather than depending on the optimization.
 */
const env: Env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent' as Env['LOG_LEVEL'],
  DATABASE_URL: APP_URL,
  DATABASE_POOL_MAX: 5,
  DATABASE_REALTIME_URL: REALTIME_URL,
  /* Unused by gateway.ts now — it takes the imported CryptoKey directly as
     `jwtPublicKey` below, the same way main.ts imports it before calling
     buildGateway. This placeholder only exists to satisfy Env's shape. */
  JWT_PUBLIC_KEY: 'unused-see-jwtPublicKey-option',
  REALTIME_PORT: PORT,
  REALTIME_HOST: '127.0.0.1',
  REALTIME_TRUST_PROXY: false,
  WEB_ORIGIN: ORIGIN,
  REALTIME_REAUTH_LEAD_SECONDS: 60,
  REALTIME_POLL_INTERVAL_MS: 400,
  REALTIME_MAX_CONNECTIONS_PER_IP_PER_MINUTE: 500,
  REALTIME_MAX_JOINS_PER_MINUTE: 500,
  REALTIME_MAX_REFUSED_JOINS_PER_MINUTE: 500,
  REALTIME_MAX_SIGNALS_PER_MINUTE: 5000,
};

let admin: AdminConnection;
let gateway: Gateway;
const open: ClientSocket[] = [];

async function tokenFor(userId: UserId): Promise<string> {
  return signAccessToken(
    {
      userId,
      sessionId: `sess-${userId}`,
      authenticatedAt: Math.floor(Date.now() / 1000),
    },
    { privateKey: JWT_PRIVATE_KEY },
  );
}

/** A connected client, or a rejection carrying the gateway's refusal. */
async function client(userId: UserId, origin = ORIGIN): Promise<ClientSocket> {
  const socket = connect(`http://127.0.0.1:${String(PORT)}`, {
    path: '/socket.io',
    transports: ['websocket'],
    extraHeaders: { Origin: origin },
    auth: { token: await tokenFor(userId) },
    reconnection: false,
  });
  open.push(socket);

  return new Promise((resolve, reject) => {
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', reject);
  });
}

async function join(socket: ClientSocket, boardId: string): Promise<boolean> {
  return new Promise((resolve) => {
    socket.emit('board:join', { orgId: ORG, boardId }, (ack: { ok: boolean }) => {
      resolve(ack.ok);
    });
  });
}

/** Resolves on the next broadcast, or null if none arrives within `ms`. */
async function nextBroadcast(socket: ClientSocket, ms = 4_000): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    socket.once('broadcast', (message: unknown) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

let eventCounter = 0;
async function writeCardMoved(boardId: string): Promise<void> {
  eventCounter += 1;
  const event = {
    id: `0195ff02-0000-7000-8000-${String(eventCounter).padStart(12, '0')}`,
    name: 'card.moved',
    version: 1,
    orgId: ORG,
    actorId: MEMBER,
    occurredAt: new Date().toISOString(),
    requestId: 'req-gateway-integration',
    payload: { cardId: 'card-1', boardId, toListId: 'list-2', toRank: 'b5' },
  } as unknown as DomainEvent;

  await withOrgScope(ORG as OrgId, async (tx) => appendToOutbox(tx, [event]));
}

async function cleanup(): Promise<void> {
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [ORG]);
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
      [userId, `gateway-int-${String(index)}@example.test`],
    );
  }

  await admin.setOrg(ORG);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, 'GW', 'gw-int')`, [
    ORG,
  ]);
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [ORG, MEMBER],
  );
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, 'GW', 'GWI')`,
    [PROJECT, ORG],
  );
  for (const boardId of [BOARD_A, BOARD_B]) {
    await admin.query(
      `INSERT INTO work.boards (id, org_id, project_id, name, rank)
       VALUES ($1, $2, $3, 'Board', 'a0')`,
      [boardId, ORG, PROJECT],
    );
  }

  initializeDatabase({ url: APP_URL, applicationName: 'gateway-int-app' });
  initializeRealtimeDatabase({ url: REALTIME_URL, applicationName: 'gateway-int-realtime' });

  gateway = buildGateway({ env, logger, jwtPublicKey: JWT_PUBLIC_KEY });
  await gateway.listen();
}, 60_000);

afterAll(async () => {
  for (const socket of open) socket.disconnect();
  await gateway.close();
  await closeDatabase();
  await cleanup();
  await admin.end();
}, 60_000);

describe('the gateway, end to end', () => {
  it('delivers a broadcast to every client in the board’s room', async () => {
    const first = await client(MEMBER);
    const second = await client(MEMBER);

    expect(await join(first, BOARD_A)).toBe(true);
    expect(await join(second, BOARD_A)).toBe(true);

    const both = Promise.all([nextBroadcast(first), nextBroadcast(second)]);
    await writeCardMoved(BOARD_A);
    const [a, b] = await both;

    // The §5 headline: a move made elsewhere reaches an open board with no
    // refresh, through the real outbox, the real relay and the real room.
    expect(a).toMatchObject({ name: 'card.moved', boardId: BOARD_A });
    expect(b).toMatchObject({ name: 'card.moved', boardId: BOARD_A });
  }, 30_000);

  it('carries the mutation id and actor the client needs to drop its own echo (§3.6)', async () => {
    const socket = await client(MEMBER);
    expect(await join(socket, BOARD_A)).toBe(true);

    const received = nextBroadcast(socket);
    await writeCardMoved(BOARD_A);

    expect(await received).toMatchObject({
      actorId: MEMBER,
      mutationId: 'req-gateway-integration',
      version: 1,
      orgId: ORG,
    });
  }, 30_000);

  it('sends occurredAt as an ISO STRING, not a Date (§6.3)', async () => {
    const socket = await client(MEMBER);
    expect(await join(socket, BOARD_A)).toBe(true);

    const received = nextBroadcast(socket);
    await writeCardMoved(BOARD_A);
    const message = (await received) as { occurredAt: unknown };

    // The wire lies about dates here exactly as it does over tRPC. Asserting the
    // runtime type is what keeps `wire.ts`'s claim honest.
    expect(typeof message.occurredAt).toBe('string');
    expect(new Date(message.occurredAt as string).getTime()).not.toBeNaN();
  }, 30_000);

  it('does not deliver a board’s events to a client in another room', async () => {
    const onA = await client(MEMBER);
    const onB = await client(MEMBER);

    expect(await join(onA, BOARD_A)).toBe(true);
    expect(await join(onB, BOARD_B)).toBe(true);

    const wrongRoom = nextBroadcast(onB, 3_000);
    const rightRoom = nextBroadcast(onA);
    await writeCardMoved(BOARD_A);

    expect(await rightRoom).toMatchObject({ boardId: BOARD_A });
    // Room scoping is the only thing standing between two tenants' boards on
    // one gateway process; a null here is the whole point of the assertion.
    expect(await wrongRoom).toBeNull();
  }, 30_000);

  it('refuses a join for a board the caller has no membership on', async () => {
    // A REAL, verifiable token — the handshake succeeds, and the refusal comes
    // from `can()` at the room, which is precisely §5's distinction.
    const outsider = await client(OUTSIDER);

    expect(await join(outsider, BOARD_A)).toBe(false);
  }, 30_000);

  it('never delivers to a socket whose join was refused', async () => {
    const outsider = await client(OUTSIDER);
    await join(outsider, BOARD_A);

    const nothing = nextBroadcast(outsider, 3_000);
    await writeCardMoved(BOARD_A);

    expect(await nothing).toBeNull();
  }, 30_000);

  it('refuses a handshake with no token', async () => {
    const socket = connect(`http://127.0.0.1:${String(PORT)}`, {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { Origin: ORIGIN },
      reconnection: false,
    });
    open.push(socket);

    await expect(
      new Promise<void>((resolve, reject) => {
        socket.on('connect', () => {
          resolve();
        });
        socket.on('connect_error', reject);
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('refuses a handshake from a disallowed origin, even with a valid token', async () => {
    await expect(client(MEMBER, 'http://evil.test')).rejects.toThrow();
  }, 30_000);

  it('tells a client the reauth lead time rather than letting it hardcode one (§7.1)', async () => {
    const socket = connect(`http://127.0.0.1:${String(PORT)}`, {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { Origin: ORIGIN },
      auth: { token: await tokenFor(MEMBER) },
      reconnection: false,
    });
    open.push(socket);

    const ready = await new Promise<{ reauthLeadSeconds: number }>((resolve, reject) => {
      socket.on('ready', resolve);
      socket.on('connect_error', reject);
    });

    expect(ready.reauthLeadSeconds).toBe(env.REALTIME_REAUTH_LEAD_SECONDS);
  }, 30_000);
});
