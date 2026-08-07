import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { unsafeAsId, type OrgId, type PageId } from '@taskflow/contracts';
import {
  closeDatabase,
  eq,
  initializeCollabDatabase,
  initializeDatabase,
  schema,
  withCollabScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { appendUpdate, readUpdatesSince } from './persist.js';
import { compactPage } from './compaction.js';
import { latestVersion } from './versions.js';

/**
 * `compactPage` against real Postgres (ai/phase-6-docs.md §3.7, §3.8, §7.3).
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
    `cc-${slug}-${orgId.slice(0, 8)}`,
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
    applicationName: 'taskflow-collab-compaction-test',
  });
  initializeCollabDatabase({
    url: 'postgresql://taskflow_collab:collab-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-collab-compaction-test',
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

describe('compactPage', () => {
  it('is a no-op when there is nothing new since the last snapshot', async () => {
    const { orgId, pageId } = await scaffold('noop');
    const doc = new Y.Doc();

    const result = await compactPage(doc, orgId, pageId);

    expect(result).toEqual({
      compacted: false,
      prunedCount: 0,
      strippedNodes: 0,
      strippedTextRuns: 0,
    });
    expect(await latestVersion(orgId, pageId)).toBeNull();
  });

  it('writes an autosave snapshot and prunes the WAL rows it covers', async () => {
    const { orgId, pageId } = await scaffold('compact');

    const doc = new Y.Doc();
    doc.getXmlFragment('content').insert(0, [new Y.XmlText('hello')]);
    await appendUpdate(orgId, pageId, Y.encodeStateAsUpdate(doc));

    const before = await readUpdatesSince(orgId, pageId, null);
    expect(before).toHaveLength(1);

    const result = await compactPage(doc, orgId, pageId);

    expect(result.compacted).toBe(true);
    expect(result.prunedCount).toBe(1);

    const version = await latestVersion(orgId, pageId);
    expect(version).not.toBeNull();
    expect(version?.kind).toBe('autosave');

    const after = await readUpdatesSince(orgId, pageId, null);
    expect(after).toHaveLength(0);
  });

  it('strips disallowed content from the LIVE document, not just the persisted snapshot', async () => {
    const { orgId, pageId } = await scaffold('strip');

    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'click me', { link: { href: 'javascript:alert(1)' } });
    paragraph.insert(0, [text]);
    doc.getXmlFragment('content').insert(0, [paragraph]);
    await appendUpdate(orgId, pageId, Y.encodeStateAsUpdate(doc));

    const result = await compactPage(doc, orgId, pageId);

    expect(result.strippedTextRuns).toBe(1);

    // The LIVE document — the same object every connected client shares —
    // must reflect the strip, not only whatever got persisted.
    const survivingText = (doc.getXmlFragment('content').get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    expect(survivingText.toDelta()).toEqual([{ insert: 'click me' }]);

    // And the persisted snapshot must agree: replaying it must not resurrect
    // the stripped mark.
    const version = await latestVersion(orgId, pageId);
    const replay = new Y.Doc();
    Y.applyUpdate(replay, version!.state);
    const replayedText = (replay.getXmlFragment('content').get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    expect(replayedText.toDelta()).toEqual([{ insert: 'click me' }]);
  });

  it('records the snapshot with a null created_by, since compaction is not an act any user performed', async () => {
    const { orgId, pageId } = await scaffold('system');

    const doc = new Y.Doc();
    doc.getXmlFragment('content').insert(0, [new Y.XmlText('x')]);
    await appendUpdate(orgId, pageId, Y.encodeStateAsUpdate(doc));
    await compactPage(doc, orgId, pageId);

    const row = await withCollabScope(orgId, (tx) =>
      tx.select().from(schema.pageVersions).where(eq(schema.pageVersions.pageId, pageId)),
    );
    expect(row[0]?.createdBy).toBeNull();
  });
});
