import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { unsafeAsId, type OrgId, type PageId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeBacklinksDatabase,
  initializeDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { drainBacklinks, drainBacklinksFully } from './backlinks.relay.js';

/**
 * The backlinks relay (ai/phase-6-docs.md §3.10, migration 0025), against
 * real Postgres and the real `taskflow_backlinks` role — not a stub. The
 * claim step's column-level grant (`id, org_id, page_id, created_at`, never
 * `state`) is exactly the kind of thing that looks correct in a migration
 * and is only real once something actually connects as that role and tries.
 */

let admin: AdminConnection;
let created: OrgId[] = [];
let fixtureCounter = 0;

interface Fixture {
  readonly orgId: OrgId;
  readonly spaceId: string;
  /** The org's first page. */
  readonly pageId: PageId;
  /** Adds another page in the SAME org/space — a real backlink's target must share the source's org (backlinks_target_fk is composite on org_id). */
  readonly addPage: (title: string) => Promise<PageId>;
}

async function scaffold(slug: string): Promise<Fixture> {
  fixtureCounter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const spaceId = crypto.randomUUID();

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `bl-${fixtureCounter.toString(36)}-${slug.slice(0, 10)}`,
  ]);
  await admin.query(`INSERT INTO docs.spaces (id, org_id, name) VALUES ($1, $2, 'Space')`, [
    spaceId,
    orgId,
  ]);
  await admin.setOrg(null);
  created.push(orgId);

  const addPage = async (title: string): Promise<PageId> => {
    const pageId = unsafeAsId<'PageId'>(crypto.randomUUID());
    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO docs.pages (id, org_id, space_id, parent_page_id, title, rank, ancestor_ids)
       VALUES ($1, $2, $3, NULL, $4, 'a0', '{}')`,
      [pageId, orgId, spaceId, title],
    );
    await admin.setOrg(null);
    return pageId;
  };

  const pageId = await addPage(`Page ${slug}`);
  return { orgId, spaceId, pageId, addPage };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.backlinks WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.page_versions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.pages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.spaces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** A `docs.page_versions` snapshot whose content links to every page in `targets`. */
function snapshotLinkingTo(targets: readonly PageId[]): Uint8Array {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(
    0,
    targets.map((targetPageId) => {
      const el = new Y.XmlElement('pageLink');
      el.setAttribute('pageId', targetPageId);
      el.setAttribute('label', 'See also');
      return el;
    }),
  );
  doc.getXmlFragment('content').insert(0, [paragraph]);
  return Y.encodeStateAsUpdate(doc);
}

async function writeVersion(orgId: OrgId, pageId: PageId, targets: readonly PageId[]): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO docs.page_versions (id, org_id, page_id, kind, state, created_by)
     VALUES (gen_random_uuid(), $1, $2, 'autosave', $3, NULL)`,
    [orgId, pageId, Buffer.from(snapshotLinkingTo(targets))],
  );
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-backlinks-relay-test',
  });
  initializeBacklinksDatabase({
    url: 'postgresql://taskflow_backlinks:backlinks-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-backlinks-relay-test',
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

describe('drainBacklinks', () => {
  it('is a no-op when there is nothing new', async () => {
    expect(await drainBacklinks()).toEqual({ processed: 0, pagesUpdated: 0 });
  });

  it('rewrites docs.backlinks from a page_versions row, and emits page.content_updated', async () => {
    const fixture = await scaffold('rewrite');
    const target = await fixture.addPage('Target');
    await writeVersion(fixture.orgId, fixture.pageId, [target]);

    const result = await drainBacklinks();
    expect(result).toEqual({ processed: 1, pagesUpdated: 1 });

    await admin.setOrg(fixture.orgId);
    const { rows } = await admin.query(
      `SELECT target_page_id FROM docs.backlinks WHERE org_id = $1 AND source_page_id = $2`,
      [fixture.orgId, fixture.pageId],
    );
    const outbox = await admin.query(
      `SELECT payload FROM platform.outbox WHERE org_id = $1 AND name = 'page.content_updated'`,
      [fixture.orgId],
    );
    await admin.setOrg(null);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.['target_page_id']).toBe(target);
    expect(outbox.rows).toHaveLength(1);
    expect((outbox.rows[0]?.['payload'] as { pageId?: string }).pageId).toBe(fixture.pageId);
  });

  it('marks the claimed row processed — draining again finds nothing new for it', async () => {
    const fixture = await scaffold('idempotent');
    const target = await fixture.addPage('Target');
    await writeVersion(fixture.orgId, fixture.pageId, [target]);

    await drainBacklinks();
    expect(await drainBacklinks()).toEqual({ processed: 0, pagesUpdated: 0 });
  });

  it('replaces backlinks WHOLESALE — a link removed in a later version disappears, not just accumulates', async () => {
    const fixture = await scaffold('replace');
    const targetA = await fixture.addPage('Target A');
    const targetB = await fixture.addPage('Target B');

    await writeVersion(fixture.orgId, fixture.pageId, [targetA]);
    await drainBacklinks();

    // A later edit drops the link to A and adds one to B.
    await writeVersion(fixture.orgId, fixture.pageId, [targetB]);
    await drainBacklinks();

    await admin.setOrg(fixture.orgId);
    const { rows } = await admin.query(
      `SELECT target_page_id FROM docs.backlinks WHERE org_id = $1 AND source_page_id = $2`,
      [fixture.orgId, fixture.pageId],
    );
    await admin.setOrg(null);

    expect(rows.map((r) => r['target_page_id'])).toEqual([targetB]);
  });

  it('folds several page_versions rows for the SAME page into one rewrite', async () => {
    const fixture = await scaffold('dedup');
    const target = await fixture.addPage('Target');

    // Three autosave ticks land before the relay's own next tick — a real
    // scenario under a busy document.
    await writeVersion(fixture.orgId, fixture.pageId, [target]);
    await writeVersion(fixture.orgId, fixture.pageId, [target]);
    await writeVersion(fixture.orgId, fixture.pageId, [target]);

    const result = await drainBacklinks();
    expect(result).toEqual({ processed: 3, pagesUpdated: 1 });
  });

  it('attributes backlinks to the correct org when one batch spans two tenants', async () => {
    const orgA = await scaffold('multi-tenant-a');
    const orgATarget = await orgA.addPage('A Target');
    const orgB = await scaffold('multi-tenant-b');
    const orgBTarget = await orgB.addPage('B Target');

    await writeVersion(orgA.orgId, orgA.pageId, [orgATarget]);
    await writeVersion(orgB.orgId, orgB.pageId, [orgBTarget]);

    const result = await drainBacklinksFully();
    expect(result.pagesUpdated).toBeGreaterThanOrEqual(2);

    await admin.setOrg(orgA.orgId);
    const aRows = await admin.query(
      `SELECT target_page_id FROM docs.backlinks WHERE org_id = $1`,
      [orgA.orgId],
    );
    await admin.setOrg(orgB.orgId);
    const bRows = await admin.query(
      `SELECT target_page_id FROM docs.backlinks WHERE org_id = $1`,
      [orgB.orgId],
    );
    await admin.setOrg(null);

    expect(aRows.rows.map((r) => r['target_page_id'])).toEqual([orgATarget]);
    expect(bRows.rows.map((r) => r['target_page_id'])).toEqual([orgBTarget]);
  });
});
