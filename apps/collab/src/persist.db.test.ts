import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type PageId } from '@taskflow/contracts';
import { closeDatabase, initializeCollabDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { appendUpdate, readUpdatesSince } from './persist.js';

/**
 * `appendUpdate`/`readUpdatesSince` against real Postgres, as `taskflow_collab`
 * (ai/phase-6-docs.md §3.7, §6.1) — the DB round trip `persist.test.ts`'s
 * pure `extractUpdateBytes` tests don't cover.
 */

let admin: AdminConnection;
let created: OrgId[] = [];

async function addPage(orgId: OrgId, spaceId: string, title: string): Promise<PageId> {
  const pageId = unsafeAsId<'PageId'>(crypto.randomUUID());
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO docs.pages (id, org_id, space_id, parent_page_id, title, rank, ancestor_ids)
     VALUES ($1, $2, $3, NULL, $4, 'a0', '{}')`,
    [pageId, orgId, spaceId, title],
  );
  await admin.setOrg(null);
  return pageId;
}

async function scaffold(slug: string): Promise<{ orgId: OrgId; spaceId: string; pageId: PageId }> {
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const spaceId = crypto.randomUUID();

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `collab-persist-${slug}-${orgId.slice(0, 8)}`,
  ]);
  await admin.query(`INSERT INTO docs.spaces (id, org_id, name) VALUES ($1, $2, $3)`, [
    spaceId,
    orgId,
    'Space',
  ]);
  await admin.setOrg(null);

  created.push(orgId);
  const pageId = await addPage(orgId, spaceId, 'Page');
  return { orgId, spaceId, pageId };
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
    applicationName: 'taskflow-collab-persist-test',
  });
  initializeCollabDatabase({
    url: 'postgresql://taskflow_collab:collab-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-collab-persist-test',
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

describe('appendUpdate / readUpdatesSince', () => {
  it('round-trips a single update', async () => {
    const { orgId, pageId } = await scaffold('single');
    const data = new Uint8Array([1, 2, 3, 4]);

    await appendUpdate(orgId, pageId, data);

    const rows = await readUpdatesSince(orgId, pageId, null);
    expect(rows).toHaveLength(1);
    expect(new Uint8Array(rows[0]!.data)).toEqual(data);
  });

  it('returns updates in insertion order', async () => {
    const { orgId, pageId } = await scaffold('order');

    await appendUpdate(orgId, pageId, new Uint8Array([1]));
    await appendUpdate(orgId, pageId, new Uint8Array([2]));
    await appendUpdate(orgId, pageId, new Uint8Array([3]));

    const rows = await readUpdatesSince(orgId, pageId, null);
    expect(rows.map((row) => Array.from(row.data))).toEqual([[1], [2], [3]]);
  });

  it('never drops an update strictly after the boundary, even though the boundary is millisecond-truncated', async () => {
    // persist.ts's own doc comment on readUpdatesSince: the JS Date `after`
    // boundary truncates Postgres's microsecond timestamptz, which can
    // re-include the boundary row itself but must never exclude a later
    // one — that is the property this test actually needs to hold, not
    // exact millisecond exclusion, which the driver does not guarantee.
    const { orgId, pageId } = await scaffold('since');

    await appendUpdate(orgId, pageId, new Uint8Array([1]));
    const rows1 = await readUpdatesSince(orgId, pageId, null);
    const cutoff = rows1[0]!.createdAt;

    await appendUpdate(orgId, pageId, new Uint8Array([2]));

    const rows2 = await readUpdatesSince(orgId, pageId, cutoff);
    const payloads = rows2.map((row) => Array.from(row.data));
    expect(payloads).toContainEqual([2]);
    expect(payloads.every((payload) => payload.length === 1)).toBe(true);
  });

  it('scopes to the named page only, not just the org', async () => {
    const { orgId, spaceId, pageId } = await scaffold('scope');
    const otherPageId = await addPage(orgId, spaceId, 'Other page');

    await appendUpdate(orgId, pageId, new Uint8Array([1]));
    await appendUpdate(orgId, otherPageId, new Uint8Array([9]));

    const rows = await readUpdatesSince(orgId, pageId, null);
    expect(rows.map((row) => Array.from(row.data))).toEqual([[1]]);
  });
});
