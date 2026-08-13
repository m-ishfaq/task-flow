import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  unsafeAsId,
  type OrgId,
  type PageId,
  type SpaceId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import * as grants from '../tenancy/grant.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as spaces from './space.service.js';
import * as pages from './page.service.js';
import * as pageVersions from './page-version.service.js';
import type { DocsActor } from './shared.js';

/**
 * Page versions, Wave 2's ordinary-API-path half (ai/phase-6-docs.md §3.7),
 * against real Postgres.
 *
 * What this suite does NOT cover: the cross-process property that
 * `apps/collab`'s `replayPage` actually picks up a restore on a fresh load.
 * That belongs with task #17's integration tests, which drive both apps —
 * asserting it here would mean either duplicating `apps/collab`'s replay
 * logic or importing from it, and this file only has `apps/api` in scope.
 * What IS in scope, and what "a slice with untested authorization is not
 * done" requires of this file specifically: that `savePageVersion` writes a
 * real snapshot of whatever is materialized from the WAL, that
 * `restorePageVersion` round-trips through the same tables `apps/collab`
 * reads (a WAL row plus a new snapshot row), and that both routes enforce
 * `page:update` — not just `page:read` — since a version write is content,
 * not metadata.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000101');
const MEMBER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@pageversions.test'],
  [MEMBER, 'member@pageversions.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee10-0000-7000-8000-0000000001ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<DocsActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.page_versions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.yjs_updates WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.pages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.spaces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: DocsActor;
  readonly spaceId: SpaceId;
  readonly pageId: PageId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');
  const space = await spaces.createSpace(owner, { name: 'Handbook' });
  const page = await pages.createPage(owner, {
    spaceId: space.spaceId,
    parentPageId: null,
    title: 'Runbook',
  });
  return { orgId, owner, spaceId: space.spaceId, pageId: page.pageId };
}

/** A minimal encoded Yjs update carrying one text run, for content-bearing tests. */
function encodedUpdateWithText(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment('content').insert(0, [new Y.XmlText(text)]);
  return Y.encodeStateAsUpdate(doc);
}

async function appendWalRow(orgId: OrgId, pageId: PageId, data: Uint8Array): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO docs.yjs_updates (id, org_id, page_id, data) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [orgId, pageId, Buffer.from(data)],
  );
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

  initializeDatabase({
    url: TEST_ENV.DATABASE_URL,
    applicationName: 'taskflow-docs-pageversion-test',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('savePageVersion', () => {
  it('materializes the WAL into a manual snapshot, attributed to the actor, and emits page.version_saved', async () => {
    const fixture = await scaffold('save-basic');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('hello'));

    const { versionId } = await pageVersions.savePageVersion(fixture.owner, {
      pageId: fixture.pageId,
    });

    const list = await pageVersions.listPageVersions(fixture.owner, { pageId: fixture.pageId });
    expect(list).toHaveLength(1);
    expect(list[0]?.versionId).toBe(versionId);
    expect(list[0]?.kind).toBe('manual');
    expect(list[0]?.createdBy).toBe(fixture.owner.subject.userId);

    await admin.setOrg(fixture.orgId);
    const { rows } = await admin.query(`SELECT state FROM docs.page_versions WHERE id = $1`, [
      versionId,
    ]);
    await admin.setOrg(null);
    const state = (rows[0] as { state: Buffer }).state;

    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(state));
    const text = replay.getXmlFragment('content').get(0) as Y.XmlText;
    expect(text.toString()).toBe('hello');

    await admin.setOrg(fixture.orgId);
    const outbox = await admin.query(
      `SELECT name, payload FROM platform.outbox WHERE org_id = $1 AND name = 'page.version_saved'`,
      [fixture.orgId],
    );
    await admin.setOrg(null);
    expect(outbox.rows).toHaveLength(1);
    expect((outbox.rows[0]?.['payload'] as { versionId?: string }).versionId).toBe(versionId);
  });

  it('with no WAL rows and no prior snapshot, saves an empty-document snapshot rather than failing', async () => {
    const fixture = await scaffold('save-empty');

    const { versionId } = await pageVersions.savePageVersion(fixture.owner, {
      pageId: fixture.pageId,
    });

    const list = await pageVersions.listPageVersions(fixture.owner, { pageId: fixture.pageId });
    expect(list).toHaveLength(1);
    expect(list[0]?.versionId).toBe(versionId);
  });

  it('refuses a guest holding only a viewer tuple — visible but not writable, so FORBIDDEN not NOT_FOUND', async () => {
    const fixture = await scaffold('save-forbidden');
    await members.addMember(
      fixture.orgId,
      { email: 'member@pageversions.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'viewer',
        objectType: 'page',
        objectId: fixture.pageId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, MEMBER, 'guest');

    await expect(
      pageVersions.savePageVersion(guest, { pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a guest with no tuple anywhere in the chain gets NOT_FOUND, not FORBIDDEN — the page is invisible to them', async () => {
    const fixture = await scaffold('save-invisible');
    await members.addMember(
      fixture.orgId,
      { email: 'member@pageversions.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, MEMBER, 'guest');

    await expect(
      pageVersions.savePageVersion(guest, { pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('listPageVersions', () => {
  it('lists newest first', async () => {
    const fixture = await scaffold('list-order');
    const first = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });
    const second = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });

    const list = await pageVersions.listPageVersions(fixture.owner, { pageId: fixture.pageId });
    expect(list.map((v) => v.versionId)).toEqual([second.versionId, first.versionId]);
  });

  it('is readable with page:read alone — a member with no update grant can still list', async () => {
    const fixture = await scaffold('list-read-only');
    await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });
    await members.addMember(
      fixture.orgId,
      { email: 'member@pageversions.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    await expect(
      pageVersions.listPageVersions(member, { pageId: fixture.pageId }),
    ).resolves.toHaveLength(1);
  });
});

describe('restorePageVersion', () => {
  it('writes a new manual snapshot and NO new WAL row, and emits page.version_restored', async () => {
    const fixture = await scaffold('restore-basic');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('original'));
    const saved = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });

    // Content moves on after the save the restore will target.
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText(' edited'));

    await admin.setOrg(fixture.orgId);
    const before = await admin.query(`SELECT id FROM docs.yjs_updates WHERE page_id = $1`, [
      fixture.pageId,
    ]);
    await admin.setOrg(null);
    expect(before.rows).toHaveLength(2);

    await pageVersions.restorePageVersion(fixture.owner, {
      pageId: fixture.pageId,
      versionId: saved.versionId,
    });

    await admin.setOrg(fixture.orgId);
    const after = await admin.query(`SELECT id FROM docs.yjs_updates WHERE page_id = $1`, [
      fixture.pageId,
    ]);
    await admin.setOrg(null);
    // Deliberately UNCHANGED — see page-version.service.ts's file header on
    // why restore writes only a new snapshot, never a WAL row: reapplying an
    // old state as a new update cannot un-insert what came after it.
    expect(after.rows).toHaveLength(2);

    const list = await pageVersions.listPageVersions(fixture.owner, { pageId: fixture.pageId });
    expect(list).toHaveLength(2);
    expect(list[0]?.kind).toBe('manual');
    expect(list[0]?.versionId).not.toBe(saved.versionId);

    await admin.setOrg(fixture.orgId);
    const outbox = await admin.query(
      `SELECT payload FROM platform.outbox WHERE org_id = $1 AND name = 'page.version_restored'`,
      [fixture.orgId],
    );
    await admin.setOrg(null);
    expect(outbox.rows).toHaveLength(1);
    expect((outbox.rows[0]?.['payload'] as { versionId?: string }).versionId).toBe(saved.versionId);
  });

  it('the restored snapshot replays to the pre-edit content, not the content at restore time', async () => {
    const fixture = await scaffold('restore-content');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('v1'));
    const saved = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('v2-only'));

    await pageVersions.restorePageVersion(fixture.owner, {
      pageId: fixture.pageId,
      versionId: saved.versionId,
    });

    const list = await pageVersions.listPageVersions(fixture.owner, { pageId: fixture.pageId });
    const restoredVersionId = list[0]?.versionId;

    await admin.setOrg(fixture.orgId);
    const { rows } = await admin.query(`SELECT state FROM docs.page_versions WHERE id = $1`, [
      restoredVersionId,
    ]);
    await admin.setOrg(null);
    const state = (rows[0] as { state: Buffer }).state;

    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(state));
    const text = replay.getXmlFragment('content').get(0) as Y.XmlText;
    expect(text.toString()).toBe('v1');
  });

  it("materializeCurrentState (the same path a later save or apps/collab's replay uses) sees the restored content, not a CRDT union of it with the superseded edit", async () => {
    // The property the original (buggy) WAL-append implementation got wrong:
    // re-applying an old Yjs state as a new update MERGES it with whatever
    // came after, it does not supersede it. This test reads back through
    // `savePageVersion`'s own materialization — the identical code path
    // `apps/collab`'s `replayPage` mirrors — rather than decoding the
    // snapshot row directly, so it would have failed against the original
    // implementation exactly as the real end-to-end gateway test did.
    const fixture = await scaffold('restore-no-union');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('original'));
    const saved = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText(' edited'));

    await pageVersions.restorePageVersion(fixture.owner, {
      pageId: fixture.pageId,
      versionId: saved.versionId,
    });

    const resaved = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const { rows } = await admin.query(`SELECT state FROM docs.page_versions WHERE id = $1`, [
      resaved.versionId,
    ]);
    await admin.setOrg(null);
    const state = (rows[0] as { state: Buffer }).state;

    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(state));
    // `YXmlFragment.prototype.toString` genuinely serializes at runtime, but
    // its `.d.ts` declares no override — the same confirmed upstream types
    // gap `apps/collab`'s `replay.test.ts` documents.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const text: string = replay.getXmlFragment('content').toString();
    expect(text).toBe('original');
  });

  it('materializeCurrentState is correct even when the restore snapshot and the superseded WAL row land in the same millisecond', async () => {
    // The previous test relies on real elapsed time to keep the restore
    // snapshot's `createdAt` after the superseded WAL row's — which is true
    // in production (a restore always follows its prior edits by real
    // human/network latency) but is NOT guaranteed on a fast connection,
    // where two sequential inserts can land in the same millisecond. This
    // test forces exactly that collision, deterministically, to prove the
    // boundary in `materializeCurrentState` (via `walRowsSinceLatestSnapshot`
    // in `@taskflow/db`) is resolved entirely inside Postgres rather than by
    // comparing a JS-truncated `Date` — see that function's own header for
    // why a JS round trip of the boundary is unsafe here.
    const fixture = await scaffold('restore-collision');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('original'));
    const saved = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText(' edited'));

    await pageVersions.restorePageVersion(fixture.owner, {
      pageId: fixture.pageId,
      versionId: saved.versionId,
    });

    // Identify the two rows first, while ordering is still normal, then pin
    // both timestamps inside the SAME millisecond, sharing one truncated
    // `now()` so neither drifts outside a plausible "current" range relative
    // to their unmodified siblings: the WAL row 100 microseconds into that
    // millisecond, the restore snapshot 900 microseconds in (later — still
    // correctly the "latest" row by its real, stored value).
    await admin.setOrg(fixture.orgId);
    const walIdRow = await admin.query(
      `SELECT id FROM docs.yjs_updates WHERE page_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [fixture.pageId],
    );
    const snapIdRow = await admin.query(
      `SELECT id FROM docs.page_versions WHERE page_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [fixture.pageId],
    );
    const walId = (walIdRow.rows[0] as { id: string }).id;
    const snapId = (snapIdRow.rows[0] as { id: string }).id;

    await admin.query(
      `WITH base AS (SELECT date_trunc('millisecond', now()) AS t)
       UPDATE docs.yjs_updates SET created_at = (SELECT t FROM base) + interval '100 microseconds'
        WHERE id = $1`,
      [walId],
    );
    await admin.query(
      `WITH base AS (SELECT date_trunc('millisecond', created_at) AS t FROM docs.yjs_updates WHERE id = $1)
       UPDATE docs.page_versions SET created_at = (SELECT t FROM base) + interval '900 microseconds'
        WHERE id = $2`,
      [walId, snapId],
    );
    await admin.setOrg(null);

    const resaved = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const { rows } = await admin.query(`SELECT state FROM docs.page_versions WHERE id = $1`, [
      resaved.versionId,
    ]);
    await admin.setOrg(null);
    const state = (rows[0] as { state: Buffer }).state;

    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(state));
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const text: string = replay.getXmlFragment('content').toString();
    expect(text).toBe('original');
  });

  it('throws NOT_FOUND for a version id that does not exist', async () => {
    const fixture = await scaffold('restore-missing');

    await expect(
      pageVersions.restorePageVersion(fixture.owner, {
        pageId: fixture.pageId,
        versionId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND for a version id that belongs to a different page', async () => {
    const fixture = await scaffold('restore-cross-page');
    const otherPage = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Other',
    });
    const saved = await pageVersions.savePageVersion(fixture.owner, { pageId: otherPage.pageId });

    await expect(
      pageVersions.restorePageVersion(fixture.owner, {
        pageId: fixture.pageId,
        versionId: saved.versionId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a guest holding only a viewer tuple — visible but not writable, so FORBIDDEN not NOT_FOUND', async () => {
    const fixture = await scaffold('restore-forbidden');
    const saved = await pageVersions.savePageVersion(fixture.owner, { pageId: fixture.pageId });
    await members.addMember(
      fixture.orgId,
      { email: 'member@pageversions.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'viewer',
        objectType: 'page',
        objectId: fixture.pageId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, MEMBER, 'guest');

    await expect(
      pageVersions.restorePageVersion(guest, {
        pageId: fixture.pageId,
        versionId: saved.versionId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
