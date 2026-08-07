import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { unsafeAsId, type OrgId, type PageId } from '@taskflow/contracts';
import { closeDatabase, initializeCollabDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { appendUpdate } from './persist.js';
import { replayPage } from './replay.js';
import { writeVersion } from './versions.js';

/**
 * `replayPage` against real Postgres (ai/phase-6-docs.md §3.7) — the
 * property Wave 2's own acceptance criteria names explicitly: "a disconnect
 * and reconnect resumes from the update log correctly."
 */

let admin: AdminConnection;
let created: OrgId[] = [];

async function scaffold(slug: string): Promise<{ orgId: OrgId; pageId: PageId }> {
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const spaceId = crypto.randomUUID();
  const pageId = unsafeAsId<'PageId'>(crypto.randomUUID());

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `cr-${slug}-${orgId.slice(0, 8)}`,
  ]);
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

  created.push(orgId);
  return { orgId, pageId };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM docs.yjs_updates WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.page_versions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.pages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.spaces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-collab-replay-test',
  });
  initializeCollabDatabase({
    url: 'postgresql://taskflow_collab:collab-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-collab-replay-test',
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
  await admin.end();
});

/**
 * YXmlFragment.prototype.toString genuinely serializes at runtime (confirmed
 * directly in yjs's compiled output — see persist.test.ts's identical note),
 * but its .d.ts declares no override, so eslint's type-aware no-base-to-string
 * sees only Object.prototype.toString here. A confirmed upstream types gap.
 */
function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return doc.getXmlFragment('content').toString();
}

describe('replayPage', () => {
  it('leaves a fresh Y.Doc empty when the page has no snapshot and no WAL rows', async () => {
    const { orgId, pageId } = await scaffold('empty');
    const doc = new Y.Doc();

    await replayPage(doc, orgId, pageId);

    expect(textOf(doc)).toBe('');
  });

  it('replays WAL-only history when no snapshot exists yet', async () => {
    const { orgId, pageId } = await scaffold('wal-only');

    const source = new Y.Doc();
    source.getXmlFragment('content').insert(0, [new Y.XmlText('hello')]);
    await appendUpdate(orgId, pageId, Y.encodeStateAsUpdate(source));

    const doc = new Y.Doc();
    await replayPage(doc, orgId, pageId);

    expect(textOf(doc)).toBe(textOf(source));
  });

  it('replays a snapshot plus the WAL tail written after it, not the whole history from scratch', async () => {
    const { orgId, pageId } = await scaffold('snapshot-plus-tail');

    // History that gets superseded by a snapshot.
    const beforeSnapshot = new Y.Doc();
    beforeSnapshot.getXmlFragment('content').insert(0, [new Y.XmlText('first')]);
    await appendUpdate(orgId, pageId, Y.encodeStateAsUpdate(beforeSnapshot));

    // The snapshot itself, capturing state as of here.
    await writeVersion(orgId, pageId, 'autosave', Y.encodeStateAsUpdate(beforeSnapshot));

    // A real client continuing from that same state, diverging further —
    // this is the WAL tail that must still be replayed on top of the snapshot.
    const afterSnapshot = new Y.Doc();
    Y.applyUpdate(afterSnapshot, Y.encodeStateAsUpdate(beforeSnapshot));
    const stateVectorBeforeContinuing = Y.encodeStateVector(afterSnapshot);
    afterSnapshot.getXmlFragment('content').insert(1, [new Y.XmlText(' second')]);
    const continuation = Y.encodeStateAsUpdate(afterSnapshot, stateVectorBeforeContinuing);
    await appendUpdate(orgId, pageId, continuation);

    const doc = new Y.Doc();
    await replayPage(doc, orgId, pageId);

    expect(textOf(doc)).toBe(textOf(afterSnapshot));
    expect(textOf(doc)).toContain('first');
    expect(textOf(doc)).toContain('second');
  });

  it('produces a document that converges with a live client applying the same updates directly', async () => {
    // The property that actually matters: replay is not merely "some text
    // came back", it is Yjs-state-equal to a client that received every
    // update live, which encodeStateAsUpdate comparison proves precisely.
    const { orgId, pageId } = await scaffold('converges');

    const live = new Y.Doc();
    live.getXmlFragment('content').insert(0, [new Y.XmlText('converge me')]);
    const update = Y.encodeStateAsUpdate(live);
    await appendUpdate(orgId, pageId, update);

    const replayed = new Y.Doc();
    await replayPage(replayed, orgId, pageId);

    expect(Y.encodeStateAsUpdate(replayed)).toEqual(Y.encodeStateAsUpdate(live));
  });
});
