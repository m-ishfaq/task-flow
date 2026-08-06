import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import RawWebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { unsafeAsId, type OrgId, type PageId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeCollabDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createLogger } from '@taskflow/observability';
import { signAccessToken } from '@taskflow/security';
import { loadTuples } from '@taskflow/api/tenancy/resolve';
import {
  listPageVersions,
  restorePageVersion,
  savePageVersion,
  type PageVersionSummary,
} from '@taskflow/api/docs/page-version';
import type { DocsActor } from '@taskflow/api/docs/page';
import { buildGateway, type Gateway } from './gateway.js';
import { pageDocumentName } from './document-name.js';
import type { Env } from './config/env.js';

/**
 * The full collab stack, end to end (ai/phase-6-docs.md §5, Wave 2's own
 * acceptance criteria): "two clients editing the same page converge, a
 * disconnect and reconnect resumes from the update log correctly, a version
 * restore round-trips."
 *
 * Every other Wave 2 suite tests one seam in isolation — `persist.test.ts`
 * the wire extraction, `replay.test.ts` the snapshot-plus-tail reconstruction
 * as a plain function call, `compaction.test.ts` the live-document strip.
 * None of them go through a real WebSocket, a real `onAuthenticate`, or a
 * real second server process. This suite does, mirroring
 * `apps/realtime/src/gateway.integration.test.ts`'s own reasoning almost
 * exactly: the wiring between hooks has no coverage until something drives
 * it as a client would.
 *
 * ## Why "reconnect" here means a NEW `Gateway`, not just a new WebSocket
 *
 * Hocuspocus caches a loaded `Y.Doc` in memory for as long as the process
 * keeps it around — a second connection to an already-open document does
 * NOT trigger `onLoadDocument` again, it just attaches to the live object.
 * A test that merely reconnected a client to the SAME running gateway would
 * prove nothing about the WAL or the snapshot table; it would pass even if
 * `replayPage` silently did nothing, because the in-memory document already
 * had the content. `restart()` below closes the gateway and boots a second
 * one — a genuinely empty document cache — so a fresh client's `onSynced`
 * can only be satisfied by `onLoadDocument` actually reading Postgres.
 * That is also, not incidentally, the exact scenario `page-version.service.ts`'s
 * header names as what a restore does NOT reach (a currently-open live
 * session) versus what it DOES satisfy (a fresh load) — this suite proves
 * both halves of that claim against a real server, not just documents it.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const COLLAB_URL =
  process.env['TEST_DATABASE_COLLAB_URL'] ??
  'postgresql://taskflow_collab:collab-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const ORIGIN = 'http://localhost:5173';
const SECRET = Buffer.from('d'.repeat(32), 'utf8');

const logger = createLogger({ name: 'collab-gateway-integration-test', level: 'silent' });

/**
 * `HocuspocusProviderWebsocket` constructs its socket with `new
 * WebSocketPolyfill(url)` — a single argument, no options — so there is no
 * config field for the `Origin` header a real browser sends automatically.
 * `ws`'s constructor accepts a third `options` argument that DOES set it, so
 * a one-argument subclass is what actually reaches `authenticateConnection`'s
 * origin check with a header at all, rather than the empty one `auth.ts`
 * correctly refuses.
 */
class OriginWebSocket extends RawWebSocket {
  constructor(address: string) {
    super(address, undefined, { headers: { Origin: ORIGIN } });
  }
}

let admin: AdminConnection;
let nextPort = 3520;

const requestId = unsafeAsId<'RequestId'>('0195ff10-0000-7000-8000-0000000000ff');

interface Fixture {
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly pageId: PageId;
}

let fixtureCounter = 0;

async function scaffold(): Promise<Fixture> {
  fixtureCounter += 1;
  const suffix = String(fixtureCounter).padStart(3, '0');
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const userId = unsafeAsId<'UserId'>(crypto.randomUUID());
  const spaceId = crypto.randomUUID();
  const pageId = unsafeAsId<'PageId'>(crypto.randomUUID());

  await admin.setOrg(null);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    [userId, `collab-gw-${suffix}@example.test`],
  );

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${suffix}`,
    `cgw-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [orgId, userId],
  );
  await admin.query(`INSERT INTO docs.spaces (id, org_id, name) VALUES ($1, $2, $3)`, [
    spaceId,
    orgId,
    'Space',
  ]);
  await admin.query(
    `INSERT INTO docs.pages (id, org_id, space_id, parent_page_id, title, rank, ancestor_ids)
     VALUES ($1, $2, $3, NULL, $4, 'a0', '{}')`,
    [pageId, orgId, spaceId, 'Page'],
  );
  await admin.setOrg(null);

  createdOrgs.push(orgId);
  createdUsers.push(userId);
  return { orgId, userId, pageId };
}

async function actorFor(fixture: Fixture): Promise<DocsActor> {
  const tuples = await loadTuples(fixture.orgId, fixture.userId);
  return {
    subject: { orgId: fixture.orgId, userId: fixture.userId, role: 'owner', tuples },
    requestId,
  };
}

const createdOrgs: OrgId[] = [];
const createdUsers: UserId[] = [];

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.yjs_updates WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.page_versions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.pages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.spaces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

function envFor(port: number): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent' as Env['LOG_LEVEL'],
    DATABASE_URL: APP_URL,
    DATABASE_POOL_MAX: 5,
    DATABASE_COLLAB_URL: COLLAB_URL,
    JWT_SECRET: SECRET.toString('base64'),
    COLLAB_PORT: port,
    COLLAB_HOST: '127.0.0.1',
    WEB_ORIGIN: ORIGIN,
  };
}

/** Boots a real gateway on a fresh port — a genuinely empty document cache. See the file header. */
async function startGateway(): Promise<{ gateway: Gateway; port: number }> {
  const port = nextPort;
  nextPort += 1;
  const gateway = buildGateway({ env: envFor(port), logger });
  await gateway.listen();
  return { gateway, port };
}

async function tokenFor(userId: UserId): Promise<string> {
  return signAccessToken(
    { userId, sessionId: `sess-${userId}`, authenticatedAt: Math.floor(Date.now() / 1000) },
    { secret: SECRET },
  );
}

interface Client {
  readonly provider: HocuspocusProvider;
  readonly socket: HocuspocusProviderWebsocket;
  readonly doc: Y.Doc;
}

const openClients: Client[] = [];

/** A connected, synced Hocuspocus client — the real client library, not a hand-rolled protocol driver. */
async function connectClient(
  fixture: Pick<Fixture, 'orgId' | 'pageId'>,
  userId: UserId,
  port: number,
): Promise<Client> {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${String(port)}?orgId=${fixture.orgId}`,
    WebSocketPolyfill: OriginWebSocket,
  });

  const provider = new HocuspocusProvider({
    name: pageDocumentName(fixture.pageId),
    document: doc,
    token: await tokenFor(userId),
    websocketProvider: socket,
  });
  const client = { provider, socket, doc };
  openClients.push(client);

  // `manageSocket` is only true when the provider constructs its OWN
  // websocket internally; passing a pre-built `websocketProvider` (needed to
  // set `WebSocketPolyfill`, which the url-based config branch doesn't
  // expose) leaves it false, and `attach()` — which wires the provider's
  // handlers to the socket's events at all — is only ever called
  // automatically in the `manageSocket` branch. Skipping this call is silent:
  // the websocket still connects and even authenticates, but the provider
  // never learns about it, so 'synced' never fires.
  provider.attach();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for sync'));
    }, 8_000);
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on('authenticationFailed', (data: { reason: string }) => {
      clearTimeout(timer);
      reject(new Error(`authentication failed: ${data.reason}`));
    });
  });

  return client;
}

function disconnectClient(client: Client): void {
  client.provider.destroy();
  client.socket.destroy();
}

/**
 * `YXmlFragment.prototype.toString` genuinely serializes at runtime (the
 * compiled yjs output does define it) but its `.d.ts` declares no override —
 * see `replay.test.ts`'s identical note. A confirmed upstream types gap, not
 * a mistake here.
 */
function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return doc.getXmlFragment('content').toString();
}

async function waitUntil(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!check()) throw new Error('timed out waiting for condition');
}

beforeAll(async () => {
  await applyMigrations({ url: MIGRATION_URL });
  admin = await connectAsMigrator({ url: MIGRATION_URL });

  initializeDatabase({ url: APP_URL, applicationName: 'collab-gw-int-app' });
  initializeCollabDatabase({ url: COLLAB_URL, applicationName: 'collab-gw-int-collab' });
}, 60_000);

afterEach(async () => {
  for (const client of openClients.splice(0)) disconnectClient(client);
  for (const orgId of createdOrgs.splice(0)) await removeOrg(orgId);
  const users = createdUsers.splice(0);
  if (users.length > 0) {
    await admin.setOrg(null);
    await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [users]);
  }
});

afterAll(async () => {
  await closeDatabase();
  await admin.end();
}, 60_000);

describe('the collab gateway, end to end', () => {
  it('two clients editing the same page converge to the same Yjs state', async () => {
    const fixture = await scaffold();
    const { gateway, port } = await startGateway();

    try {
      const a = await connectClient(fixture, fixture.userId, port);
      const b = await connectClient(fixture, fixture.userId, port);

      a.doc.getXmlFragment('content').insert(0, [new Y.XmlText('from A')]);
      b.doc.getXmlFragment('content').insert(0, [new Y.XmlText('from B ')]);

      await waitUntil(() => textOf(a.doc) === textOf(b.doc) && textOf(a.doc).length > 0);

      // Not merely "the same text" — the same Yjs STATE, which is the
      // property CRDT convergence actually promises.
      expect(Y.encodeStateAsUpdate(a.doc)).toEqual(Y.encodeStateAsUpdate(b.doc));
      expect(textOf(a.doc)).toContain('from A');
      expect(textOf(a.doc)).toContain('from B');
    } finally {
      await gateway.close();
    }
  }, 30_000);

  it('a disconnect, then a brand-new gateway process, resumes from the update log — not from an in-memory cache', async () => {
    const fixture = await scaffold();
    const first = await startGateway();

    const writer = await connectClient(fixture, fixture.userId, first.port);
    writer.doc.getXmlFragment('content').insert(0, [new Y.XmlText('written before restart')]);
    await waitUntil(() => textOf(writer.doc).length > 0);
    // Give beforeHandleMessage's own WAL append a moment to land — the
    // durability guarantee is that it happens BEFORE the client is acked,
    // but the client-side 'synced'/update event racing this test's own
    // read is still worth a short settle rather than asserting on a knife's
    // edge.
    await new Promise((resolve) => setTimeout(resolve, 200));

    disconnectClient(writer);
    await first.gateway.close();

    const second = await startGateway();
    try {
      const reader = await connectClient(fixture, fixture.userId, second.port);
      expect(textOf(reader.doc)).toBe('written before restart');
    } finally {
      await second.gateway.close();
    }
  }, 30_000);

  it('a version restore round-trips through a fresh gateway process, and does NOT reach an already-open live session', async () => {
    const fixture = await scaffold();
    const actor = await actorFor(fixture);

    const first = await startGateway();
    const original = await connectClient(fixture, fixture.userId, first.port);
    original.doc.getXmlFragment('content').insert(0, [new Y.XmlText('original content')]);
    await waitUntil(() => textOf(original.doc).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const saved: { versionId: string } = await savePageVersion(actor, { pageId: fixture.pageId });

    // The session stays open and diverges further, past the point that was saved.
    original.doc.getXmlFragment('content').insert(0, [new Y.XmlText('EDITED AFTER SAVE — ')]);
    await waitUntil(() => textOf(original.doc).startsWith('EDITED AFTER SAVE'));
    await new Promise((resolve) => setTimeout(resolve, 200));

    await restorePageVersion(actor, { pageId: fixture.pageId, versionId: saved.versionId });

    // The already-open session does NOT see the restore — page-version.service.ts's
    // own documented limitation, proved here rather than assumed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(textOf(original.doc)).toContain('EDITED AFTER SAVE');

    disconnectClient(original);
    await first.gateway.close();

    // A fresh process, with no cached document, DOES reflect the restore —
    // the round-trip Wave 2's acceptance criterion actually asks for.
    const second = await startGateway();
    try {
      const reader = await connectClient(fixture, fixture.userId, second.port);
      expect(textOf(reader.doc)).toBe('original content');
    } finally {
      await second.gateway.close();
    }
  }, 30_000);

  it('lists the manual save and the restore as two distinct versions, newest first', async () => {
    const fixture = await scaffold();
    const actor = await actorFor(fixture);

    const gw = await startGateway();
    try {
      const client = await connectClient(fixture, fixture.userId, gw.port);
      client.doc.getXmlFragment('content').insert(0, [new Y.XmlText('v1')]);
      await waitUntil(() => textOf(client.doc).length > 0);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const saved = await savePageVersion(actor, { pageId: fixture.pageId });
      await restorePageVersion(actor, { pageId: fixture.pageId, versionId: saved.versionId });

      const versions: readonly PageVersionSummary[] = await listPageVersions(actor, {
        pageId: fixture.pageId,
      });

      expect(versions).toHaveLength(2);
      expect(versions[0]?.versionId).not.toBe(saved.versionId);
      expect(versions[1]?.versionId).toBe(saved.versionId);
    } finally {
      await gw.gateway.close();
    }
  }, 30_000);
});
