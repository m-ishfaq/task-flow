import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { closeDatabase, initializeDatabase, initializeRealtimeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createLogger } from '@taskflow/observability';
import { signAccessToken } from '@taskflow/security';
import { generateTestAccessTokenKeyPair } from '@taskflow/security/testing';
import { unsafeAsId, type UserId } from '@taskflow/contracts';
import { buildGateway, type Gateway } from './gateway.js';
import { RTC_NAMESPACE } from './wire.js';
import type { Env } from './config/env.js';

/**
 * In-app voice signalling, end to end (ai/phase-13-webrtc.md §3.1, §3.2).
 *
 * ## The one test in this file that has to exist
 *
 * `refuses to relay a signal addressed to somebody outside the call room`.
 *
 * §3.2: the `to` field is a SELECTOR over a roster the server holds, never a
 * routing key. The wrong implementation — `socket.to(userRoom(to)).emit(...)` —
 * compiles, reads fine, passes every unit test written against the handler's
 * inputs, and gives any authorized socket a message-injection primitive into any
 * browser in the deployment. Nothing short of two real clients and a real room
 * distinguishes it from the right one, which is the same lesson
 * `apps/collab/src/gateway.integration.test.ts` learned about `onAuthenticate`'s
 * context: the bug lived in what the framework did with a value, not in the
 * value.
 *
 * Everything here is real except the port: a real gateway, real socket.io
 * clients holding real access tokens, real rows under RLS.
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

/** Its own port — this suite and the board gateway's may run concurrently. */
const PORT = 3479;
const ORIGIN = 'http://localhost:5173';
const { privateKey: JWT_PRIVATE_KEY, publicKey: JWT_PUBLIC_KEY } =
  await generateTestAccessTokenKeyPair();

/** ⚠ Prefix `0195ff03`, used by no other suite. See gateway.integration.test.ts. */
const ORG = '0195ff03-0000-7000-8000-0000000000a1';
const ALICE = unsafeAsId<'UserId'>('0195ff03-0000-7000-8000-000000000a01');
const BOB = unsafeAsId<'UserId'>('0195ff03-0000-7000-8000-000000000a02');
/** In the org, not in the DM. The §1 refusal depends on this person existing. */
const OUTSIDER = unsafeAsId<'UserId'>('0195ff03-0000-7000-8000-000000000a03');

const ALL_USER_IDS = [ALICE, BOB, OUTSIDER];

const CHANNEL = '0195ff03-0000-7000-8000-000000000b01';
const SESSION = '0195ff03-0000-7000-8000-000000000c01';
/** A session id nobody has a row for — the "room nobody validated" case. */
const PHANTOM_SESSION = '0195ff03-0000-7000-8000-000000000c99';

const logger = createLogger({ name: 'rtc-integration-test', level: 'silent' });

const env: Env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent' as Env['LOG_LEVEL'],
  DATABASE_URL: APP_URL,
  DATABASE_POOL_MAX: 5,
  DATABASE_REALTIME_URL: REALTIME_URL,
  /* Unused by gateway.ts now — see gateway.integration.test.ts's identical note. */
  JWT_PUBLIC_KEY: 'unused-see-jwtPublicKey-option',
  REALTIME_PORT: PORT,
  REALTIME_HOST: '127.0.0.1',
  REALTIME_TRUST_PROXY: false,
  WEB_ORIGIN: ORIGIN,
  REALTIME_REAUTH_LEAD_SECONDS: 60,
  REALTIME_POLL_INTERVAL_MS: 5_000,
  REALTIME_MAX_CONNECTIONS_PER_IP_PER_MINUTE: 500,
  REALTIME_MAX_JOINS_PER_MINUTE: 500,
  REALTIME_MAX_REFUSED_JOINS_PER_MINUTE: 500,
  REALTIME_MAX_SIGNALS_PER_MINUTE: 5_000,
};

let admin: AdminConnection;
let gateway: Gateway;
const open: ClientSocket[] = [];

async function tokenFor(userId: UserId): Promise<string> {
  return signAccessToken(
    { userId, sessionId: `sess-${userId}`, authenticatedAt: Math.floor(Date.now() / 1000) },
    { privateKey: JWT_PRIVATE_KEY },
  );
}

/** A client connected to the `/rtc` namespace. */
async function client(userId: UserId): Promise<ClientSocket> {
  const socket = connect(`http://127.0.0.1:${String(PORT)}${RTC_NAMESPACE}`, {
    path: '/socket.io',
    transports: ['websocket'],
    extraHeaders: { Origin: ORIGIN },
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

async function joinCall(socket: ClientSocket, sessionId = SESSION): Promise<boolean> {
  return new Promise((resolve) => {
    socket.emit('rtc:join', { orgId: ORG, sessionId }, (ack: { ok: boolean }) => {
      resolve(ack.ok);
    });
  });
}

/** Resolves on the next `rtc:signal`, or null if none arrives within `ms`. */
async function nextSignal(socket: ClientSocket, ms = 1_500): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    socket.once('rtc:signal', (message: unknown) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function cleanup(): Promise<void> {
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM rtc.turn_issuance WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM rtc.participants WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM rtc.sessions WHERE org_id = $1`, [ORG]);
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
      [userId, `rtc-int-${String(index)}@example.test`],
    );
  }

  await admin.setOrg(ORG);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, 'RTC', 'rtc-int')`, [
    ORG,
  ]);
  for (const userId of ALL_USER_IDS) {
    await admin.query(
      `INSERT INTO identity.memberships (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, 'member')`,
      [ORG, userId],
    );
  }

  /* A DM — the CLOSED channel type. `member` grants `channel:read` from the role
     matrix for PUBLIC channels only, so an org member with no tuple on this row
     is refused, and that refusal is the whole §1 claim. */
  await admin.query(`INSERT INTO chat.channels (id, org_id, type) VALUES ($1, $2, 'dm')`, [
    CHANNEL,
    ORG,
  ]);
  for (const userId of [ALICE, BOB]) {
    await admin.query(
      `INSERT INTO authz.relationship_tuples
         (id, org_id, subject_type, subject_id, relation, object_type, object_id)
       VALUES (gen_random_uuid(), $1, 'user', $2, 'member', 'channel', $3)`,
      [ORG, userId, CHANNEL],
    );
  }

  await admin.query(
    `INSERT INTO rtc.sessions (id, org_id, channel_id, kind, status, initiated_by,
                               max_participants, joined_count, started_at)
     VALUES ($1, $2, $3, 'audio', 'active', $4, 4, 2, now())`,
    [SESSION, ORG, CHANNEL, ALICE],
  );
  for (const userId of [ALICE, BOB]) {
    await admin.query(
      `INSERT INTO rtc.participants (session_id, org_id, user_id, state, joined_at)
       VALUES ($1, $2, $3, 'joined', now())`,
      [SESSION, ORG, userId],
    );
  }
  await admin.setOrg(null);

  initializeDatabase({ url: APP_URL, applicationName: 'rtc-int-app' });
  initializeRealtimeDatabase({ url: REALTIME_URL, applicationName: 'rtc-int-realtime' });

  gateway = buildGateway({ env, logger, jwtPublicKey: JWT_PUBLIC_KEY });
  await gateway.listen();
}, 60_000);

afterAll(async () => {
  for (const socket of open) socket.disconnect();
  await gateway.close();
  await closeDatabase();
  await cleanup();
  await admin.end();
});

describe('the /rtc namespace', () => {
  it('lets a participant of the DM join the call room', async () => {
    const alice = await client(ALICE);
    expect(await joinCall(alice)).toBe(true);
  });

  it('refuses an org member who cannot read the DM', async () => {
    /* §1 in one assertion. OUTSIDER holds `channel:read` from the ROLE matrix
       and has no tuple on this DM — `channelTarget`'s `closed` flag is the only
       thing between them and a live conversation, and `authorizeRtcJoin` reuses
       it by construction rather than re-deriving anything. */
    const outsider = await client(OUTSIDER);
    expect(await joinCall(outsider)).toBe(false);
  });

  it('refuses a room whose session does not exist', async () => {
    /* The room NAME is the only thing routing signals, so a room nobody
       validated is a room anybody can occupy — someone sitting in
       `rtc:<any uuid>` waiting for an offer addressed there. */
    const alice = await client(ALICE);
    expect(await joinCall(alice, PHANTOM_SESSION)).toBe(false);
  });

  it('relays a signal between two peers in the same call, stamping the sender', async () => {
    const alice = await client(ALICE);
    const bob = await client(BOB);
    expect(await joinCall(alice)).toBe(true);
    expect(await joinCall(bob)).toBe(true);

    const received = nextSignal(bob);
    alice.emit('rtc:signal', { sessionId: SESSION, to: BOB, kind: 'offer', data: 'v=0 sdp' });

    /* `from` is ALICE because the SERVER put it there, from the handshake
       identity. The request carries no `from` field at all — a client that could
       name its own would be able to impersonate another participant's offer and
       take over their leg of the call. */
    expect(await received).toEqual({
      sessionId: SESSION,
      from: ALICE,
      kind: 'offer',
      data: 'v=0 sdp',
    });
  });

  it('refuses to relay a signal addressed to somebody outside the call room', async () => {
    const alice = await client(ALICE);
    const outsider = await client(OUTSIDER);
    expect(await joinCall(alice)).toBe(true);
    /* OUTSIDER is connected and authenticated. They are simply not in this
       room — which is exactly the position an attacker's target is in. */

    const received = nextSignal(outsider);
    alice.emit('rtc:signal', {
      sessionId: SESSION,
      to: OUTSIDER,
      kind: 'offer',
      data: 'v=0 injected',
    });

    /* ==================================================================
       THE assertion this file exists for (§3.2).
       ==================================================================
       `socket.to(userRoom(to)).emit(...)` would deliver this. It is a
       one-line implementation that reads as obviously correct, passes any
       test written against the handler's inputs, and turns an authorized
       call room into a message-injection primitive aimed at any browser in
       the deployment.

       Because `to` selects from `fetchSockets()` on the ROOM instead, a
       target who is not in the room matches nothing and the signal is
       dropped — silently, because an ack here would be an oracle for who is
       in which call. */
    expect(await received).toBeNull();
  });

  it('does not relay a signal from a sender who never joined the room', async () => {
    const outsider = await client(OUTSIDER);
    const bob = await client(BOB);
    expect(await joinCall(bob)).toBe(true);

    const received = nextSignal(bob);
    /* No join, so `socket.data.rooms` has no entry — checked FIRST, before the
       roster read, so an unauthorized sender never even causes a lookup. */
    outsider.emit('rtc:signal', { sessionId: SESSION, to: BOB, kind: 'offer', data: 'v=0 forged' });

    expect(await received).toBeNull();
  });

  it('tells the room who is in it after a join', async () => {
    const alice = await client(ALICE);

    const peers = new Promise<{ userIds: string[] }>((resolve) => {
      alice.on('rtc:peers', (message: { userIds: string[] }) => {
        if (message.userIds.includes(ALICE)) resolve(message);
      });
    });

    expect(await joinCall(alice)).toBe(true);

    /* Broadcast AFTER the join took effect, so a client reading its own ack
       alongside the first roster message finds itself already in the list. */
    expect((await peers).userIds).toContain(ALICE);
  });
});
