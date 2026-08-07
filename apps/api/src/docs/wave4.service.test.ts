import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { unsafeAsId, type OrgId, type PageId, type SpaceId, type UserId } from '@taskflow/contracts';
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
import * as publish from './publish.service.js';
import * as templates from './template.service.js';
import { getPublishedPage } from './public.service.js';
import type { DocsActor } from './shared.js';

/**
 * Publish-to-public and page templates (ai/phase-6-docs.md §3.9, §5, Wave 4)
 * against real Postgres. PDF export's own DB-facing half
 * (`pdf-export.service.ts`) is intentionally NOT re-tested here beyond what
 * `page-version.service.test.ts` already proves about version resolution —
 * see that file for the "latest snapshot" pattern this borrows.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000101');
const MEMBER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@wave4.test'],
  [MEMBER, 'member@wave4.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee20-0000-7000-8000-0000000001ff');

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
  await admin.query(`DELETE FROM docs.page_templates WHERE org_id = $1`, [orgId]);
  // The published pointer must be cleared BEFORE page_versions rows are
  // deleted — migration 0026's composite FK (pages_published_version_fk)
  // refuses to let a page_versions row disappear out from under a page that
  // still points at it, exactly as intended.
  await admin.query(`UPDATE docs.pages SET published_version_id = NULL, published_at = NULL WHERE org_id = $1`, [
    orgId,
  ]);
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

async function memberActor(fixture: Fixture): Promise<DocsActor> {
  await members.addMember(
    fixture.orgId,
    { email: 'member@wave4.test', role: 'member' },
    { userId: OWNER, requestId },
  );
  return actorFor(fixture.orgId, MEMBER, 'member');
}

async function guestActor(fixture: Fixture, withViewerTuple: boolean): Promise<DocsActor> {
  await members.addMember(
    fixture.orgId,
    { email: 'member@wave4.test', role: 'guest' },
    { userId: OWNER, requestId },
  );
  if (withViewerTuple) {
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
  }
  return actorFor(fixture.orgId, MEMBER, 'guest');
}

function encodedUpdateWithText(text: string): Uint8Array {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('content').insert(0, [paragraph]);
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
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [USERS.map(([id]) => id)]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-docs-wave4-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [USERS.map(([id]) => id)]);
  await admin.end();
});

describe('publishPage', () => {
  it('writes a publish snapshot, points the page at it, and emits page.published', async () => {
    const fixture = await scaffold('publish-basic');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('published content'));

    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const pageRows = await admin.query(
      `SELECT published_version_id, published_at FROM docs.pages WHERE id = $1`,
      [fixture.pageId],
    );
    const versionRows = await admin.query(
      `SELECT kind FROM docs.page_versions WHERE page_id = $1`,
      [fixture.pageId],
    );
    const outbox = await admin.query(
      `SELECT payload FROM platform.outbox WHERE org_id = $1 AND name = 'page.published'`,
      [fixture.orgId],
    );
    await admin.setOrg(null);

    const row = pageRows.rows[0] as { published_version_id: string | null; published_at: Date | null };
    expect(row.published_version_id).not.toBeNull();
    expect(row.published_at).not.toBeNull();
    expect(versionRows.rows.map((r) => r['kind'])).toEqual(['publish']);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]?.['payload']).toMatchObject({
      pageId: fixture.pageId,
      versionId: row.published_version_id,
      published: true,
    });
  });

  it('re-publishing after further edits writes a NEW publish version and repoints the pointer, leaving the old one in history', async () => {
    const fixture = await scaffold('publish-again');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('v1'));
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const first = await admin.query(`SELECT published_version_id FROM docs.pages WHERE id = $1`, [
      fixture.pageId,
    ]);
    await admin.setOrg(null);
    const firstVersionId = (first.rows[0] as { published_version_id: string }).published_version_id;

    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText(' v2'));
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const second = await admin.query(`SELECT published_version_id FROM docs.pages WHERE id = $1`, [
      fixture.pageId,
    ]);
    const allVersions = await admin.query(
      `SELECT id, kind FROM docs.page_versions WHERE page_id = $1 AND kind = 'publish'`,
      [fixture.pageId],
    );
    await admin.setOrg(null);
    const secondVersionId = (second.rows[0] as { published_version_id: string }).published_version_id;

    expect(secondVersionId).not.toBe(firstVersionId);
    expect(allVersions.rows.map((r) => r['id'])).toEqual(
      expect.arrayContaining([firstVersionId, secondVersionId]),
    );
  });

  it('a member (holds page:update from the role matrix) can publish', async () => {
    const fixture = await scaffold('publish-member');
    const member = await memberActor(fixture);

    await expect(publish.publishPage(member, { pageId: fixture.pageId })).resolves.toBeUndefined();
  });

  it('a guest holding only a viewer tuple is FORBIDDEN, not NOT_FOUND', async () => {
    const fixture = await scaffold('publish-forbidden');
    const guest = await guestActor(fixture, true);

    await expect(publish.publishPage(guest, { pageId: fixture.pageId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a guest with no tuple anywhere gets NOT_FOUND — the page is invisible', async () => {
    const fixture = await scaffold('publish-invisible');
    const guest = await guestActor(fixture, false);

    await expect(publish.publishPage(guest, { pageId: fixture.pageId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('unpublishPage', () => {
  it('clears the published pointer and emits page.published with published:false and a null versionId', async () => {
    const fixture = await scaffold('unpublish-basic');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    await publish.unpublishPage(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const row = await admin.query(
      `SELECT published_version_id, published_at FROM docs.pages WHERE id = $1`,
      [fixture.pageId],
    );
    const outbox = await admin.query(
      `SELECT payload FROM platform.outbox WHERE org_id = $1 AND name = 'page.published' ORDER BY id`,
      [fixture.orgId],
    );
    await admin.setOrg(null);

    const pageRow = row.rows[0] as { published_version_id: string | null; published_at: Date | null };
    expect(pageRow.published_version_id).toBeNull();
    expect(pageRow.published_at).toBeNull();
    expect(outbox.rows).toHaveLength(2);
    expect(outbox.rows[1]?.['payload']).toMatchObject({ published: false, versionId: null });
  });

  it('unpublishing a page that was never published is NOT_FOUND', async () => {
    const fixture = await scaffold('unpublish-missing');

    await expect(publish.unpublishPage(fixture.owner, { pageId: fixture.pageId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('getPublishedPage', () => {
  it('is NOT_FOUND for a page that has never been published', async () => {
    const fixture = await scaffold('public-unpublished');

    await expect(
      getPublishedPage({ orgId: fixture.orgId, pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the published title and rendered content, with no session at all', async () => {
    const fixture = await scaffold('public-basic');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('public words'));
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    const result = await getPublishedPage({ orgId: fixture.orgId, pageId: fixture.pageId });

    expect(result.pageId).toBe(fixture.pageId);
    expect(result.title).toBe('Runbook');
    expect(result.content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'public words' }] }],
    });
  });

  it('is NOT_FOUND under the WRONG org id, even for a real, published page — RLS, not a lookup miss', async () => {
    const fixture = await scaffold('public-cross-tenant');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });
    const otherOrg = await newOrg('public-cross-tenant-other');

    await expect(
      getPublishedPage({ orgId: otherOrg, pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is NOT_FOUND once unpublished', async () => {
    const fixture = await scaffold('public-unpublish-after');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });
    await publish.unpublishPage(fixture.owner, { pageId: fixture.pageId });

    await expect(
      getPublishedPage({ orgId: fixture.orgId, pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is NOT_FOUND for a page that is published AND archived — archived is not a lie for the public reader', async () => {
    const fixture = await scaffold('public-archived');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });
    await pages.archivePage(fixture.owner, { pageId: fixture.pageId, restore: false });

    await expect(
      getPublishedPage({ orgId: fixture.orgId, pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('page templates', () => {
  it('createTemplateFromPage captures the materialized content, and listTemplates returns it', async () => {
    const fixture = await scaffold('template-create');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('template seed'));

    const { templateId } = await templates.createTemplateFromPage(fixture.owner, {
      pageId: fixture.pageId,
      name: 'Runbook template',
    });

    const list = await templates.listTemplates(fixture.owner, { spaceId: fixture.spaceId });
    expect(list).toHaveLength(1);
    expect(list[0]?.templateId).toBe(templateId);
    expect(list[0]?.name).toBe('Runbook template');

    await admin.setOrg(fixture.orgId);
    const outbox = await admin.query(
      `SELECT payload FROM platform.outbox WHERE org_id = $1 AND name = 'page.template_created'`,
      [fixture.orgId],
    );
    await admin.setOrg(null);
    expect(outbox.rows).toHaveLength(1);
  });

  it('a member (no space:manage) is FORBIDDEN to create a template, but CAN list', async () => {
    const fixture = await scaffold('template-member-forbidden');
    const member = await memberActor(fixture);

    await expect(
      templates.createTemplateFromPage(member, { pageId: fixture.pageId, name: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(templates.listTemplates(member, { spaceId: fixture.spaceId })).resolves.toEqual([]);
  });

  it('deleteTemplate removes the row and emits page.template_deleted; deleting twice is NOT_FOUND', async () => {
    const fixture = await scaffold('template-delete');
    const { templateId } = await templates.createTemplateFromPage(fixture.owner, {
      pageId: fixture.pageId,
      name: 'to delete',
    });

    await templates.deleteTemplate(fixture.owner, { templateId: unsafeAsId<'PageTemplateId'>(templateId) });

    await expect(templates.listTemplates(fixture.owner, { spaceId: fixture.spaceId })).resolves.toEqual([]);
    await expect(
      templates.deleteTemplate(fixture.owner, { templateId: unsafeAsId<'PageTemplateId'>(templateId) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('createPageFromTemplate seeds the new page so its materialized content matches the template', async () => {
    const fixture = await scaffold('template-instantiate');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('from template'));
    const { templateId } = await templates.createTemplateFromPage(fixture.owner, {
      pageId: fixture.pageId,
      name: 'seed',
    });

    const { pageId } = await templates.createPageFromTemplate(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'New Page From Template',
      templateId: unsafeAsId<'PageTemplateId'>(templateId),
    });

    await admin.setOrg(fixture.orgId);
    const rows = await admin.query(
      `SELECT state FROM docs.page_versions WHERE page_id = $1 ORDER BY created_at`,
      [pageId],
    );
    await admin.setOrg(null);
    expect(rows.rows).toHaveLength(1);

    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array((rows.rows[0] as { state: Buffer }).state));
    const paragraph = replay.getXmlFragment('content').get(0) as Y.XmlElement;
    const seededText = paragraph.get(0) as Y.XmlText;
    expect(seededText.toString()).toBe('from template');
  });

  it('createPageFromTemplate is NOT_FOUND when the template belongs to a different space', async () => {
    const fixture = await scaffold('template-wrong-space');
    const { templateId } = await templates.createTemplateFromPage(fixture.owner, {
      pageId: fixture.pageId,
      name: 'seed',
    });
    const otherSpace = await spaces.createSpace(fixture.owner, { name: 'Other Space' });

    await expect(
      templates.createPageFromTemplate(fixture.owner, {
        spaceId: otherSpace.spaceId,
        parentPageId: null,
        title: 'x',
        templateId: unsafeAsId<'PageTemplateId'>(templateId),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
