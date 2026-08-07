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
import { loadTuples } from '../tenancy/resolve.js';
import * as spaces from './space.service.js';
import * as pages from './page.service.js';
import * as pageVersions from './page-version.service.js';
import * as templates from './template.service.js';
import type { DocsActor } from './shared.js';

/**
 * Page templates (ai/phase-6-docs.md §5, Wave 4), against real Postgres.
 *
 * Covers what `template.service.ts`'s own header names as the real
 * authorization questions — creating a template needs `page:create` (role-
 * only) AND `page:read` on the specific source page being snapshotted,
 * archiving is admin/owner-only, and applying a template seeds a REAL,
 * separately-readable `page_versions` row rather than merely copying bytes
 * nobody can materialize back.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee22-0000-7000-8000-000000000101');
const MEMBER = unsafeAsId<'UserId'>('0195ee22-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@templates.test'],
  [MEMBER, 'member@templates.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee22-0000-7000-8000-0000000001ff');

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
  await admin.query(`DELETE FROM docs.templates WHERE org_id = $1`, [orgId]);
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
    title: 'Onboarding',
  });
  return { orgId, owner, spaceId: space.spaceId, pageId: page.pageId };
}

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
    applicationName: 'taskflow-docs-templates-test',
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

describe('createTemplate / listTemplates', () => {
  it('captures the source page’s current content as a detached snapshot', async () => {
    const fixture = await scaffold('create-basic');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('starter content'));

    const { templateId } = await templates.createTemplate(fixture.owner, {
      name: 'Onboarding starter',
      description: null,
      sourcePageId: fixture.pageId,
    });

    const list = await templates.listTemplates(fixture.owner);
    expect(list).toHaveLength(1);
    expect(list[0]?.templateId).toBe(templateId);
    expect(list[0]?.name).toBe('Onboarding starter');
    expect(list[0]?.sourcePageId).toBe(fixture.pageId);

    await admin.setOrg(fixture.orgId);
    const rows = await admin.query(`SELECT state FROM docs.templates WHERE id = $1`, [templateId]);
    await admin.setOrg(null);
    const state = (rows.rows[0] as { state: Buffer }).state;

    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(state));
    const text = replay.getXmlFragment('content').get(0) as Y.XmlText;
    expect(text.toString()).toBe('starter content');
  });

  it('a member may create a template — page:create is in MEMBER’s grant set', async () => {
    const fixture = await scaffold('create-member');
    await members.addMember(
      fixture.orgId,
      { email: 'member@templates.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const memberActor = await actorFor(fixture.orgId, MEMBER, 'member');

    await expect(
      templates.createTemplate(memberActor, {
        name: 'From a member',
        description: null,
        sourcePageId: fixture.pageId,
      }),
    ).resolves.toMatchObject({ templateId: expect.any(String) as string });
  });

  it('a guest with no grant on the source page gets NOT_FOUND, not FORBIDDEN — the page is invisible', async () => {
    const fixture = await scaffold('create-invisible');
    await members.addMember(
      fixture.orgId,
      { email: 'member@templates.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, MEMBER, 'guest');

    await expect(
      templates.createTemplate(guest, {
        name: 'Should not exist',
        description: null,
        sourcePageId: fixture.pageId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('excludes archived templates from the list', async () => {
    const fixture = await scaffold('list-excludes-archived');
    const { templateId } = await templates.createTemplate(fixture.owner, {
      name: 'To archive',
      description: null,
      sourcePageId: fixture.pageId,
    });

    await templates.archiveTemplate(fixture.owner, { templateId, restore: false });

    await expect(templates.listTemplates(fixture.owner)).resolves.toHaveLength(0);
  });
});

describe('archiveTemplate', () => {
  it('a plain member is refused', async () => {
    const fixture = await scaffold('archive-member-forbidden');
    const { templateId } = await templates.createTemplate(fixture.owner, {
      name: 'Owner-made',
      description: null,
      sourcePageId: fixture.pageId,
    });
    await members.addMember(
      fixture.orgId,
      { email: 'member@templates.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const memberActor = await actorFor(fixture.orgId, MEMBER, 'member');

    await expect(
      templates.archiveTemplate(memberActor, { templateId, restore: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('restore brings an archived template back into the list', async () => {
    const fixture = await scaffold('archive-restore');
    const { templateId } = await templates.createTemplate(fixture.owner, {
      name: 'Round trip',
      description: null,
      sourcePageId: fixture.pageId,
    });
    await templates.archiveTemplate(fixture.owner, { templateId, restore: false });
    await templates.archiveTemplate(fixture.owner, { templateId, restore: true });

    const list = await templates.listTemplates(fixture.owner);
    expect(list.map((t) => t.templateId)).toContain(templateId);
  });

  it('throws NOT_FOUND for an id that does not exist', async () => {
    const fixture = await scaffold('archive-missing');

    await expect(
      templates.archiveTemplate(fixture.owner, {
        templateId: unsafeAsId<'TemplateId'>(crypto.randomUUID()),
        restore: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('createPageFromTemplate', () => {
  it('creates a new page seeded with the template’s content, readable through the ordinary version machinery', async () => {
    const fixture = await scaffold('apply-basic');
    await appendWalRow(fixture.orgId, fixture.pageId, encodedUpdateWithText('template body'));
    const { templateId } = await templates.createTemplate(fixture.owner, {
      name: 'Body template',
      description: null,
      sourcePageId: fixture.pageId,
    });

    const { pageId: newPageId } = await templates.createPageFromTemplate(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'From template',
      templateId,
    });

    expect(newPageId).not.toBe(fixture.pageId);

    const list = await pageVersions.listPageVersions(fixture.owner, { pageId: newPageId });
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('manual');

    await admin.setOrg(fixture.orgId);
    const rows = await admin.query(`SELECT state FROM docs.page_versions WHERE id = $1`, [
      list[0]?.versionId,
    ]);
    await admin.setOrg(null);
    const state = (rows.rows[0] as { state: Buffer }).state;

    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(state));
    const text = replay.getXmlFragment('content').get(0) as Y.XmlText;
    expect(text.toString()).toBe('template body');
  });

  it('the new page goes through the normal page:create authorization — a guest with no grant on the space gets NOT_FOUND, the same "invisible, not merely unwritable" outcome page-version.service.test.ts pins for pages', async () => {
    const fixture = await scaffold('apply-authz');
    const { templateId } = await templates.createTemplate(fixture.owner, {
      name: 'Gate check',
      description: null,
      sourcePageId: fixture.pageId,
    });
    await members.addMember(
      fixture.orgId,
      { email: 'member@templates.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, MEMBER, 'guest');

    await expect(
      templates.createPageFromTemplate(guest, {
        spaceId: fixture.spaceId,
        parentPageId: null,
        title: 'Should not be created',
        templateId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND for an archived template', async () => {
    const fixture = await scaffold('apply-archived-template');
    const { templateId } = await templates.createTemplate(fixture.owner, {
      name: 'Retired',
      description: null,
      sourcePageId: fixture.pageId,
    });
    await templates.archiveTemplate(fixture.owner, { templateId, restore: false });

    await expect(
      templates.createPageFromTemplate(fixture.owner, {
        spaceId: fixture.spaceId,
        parentPageId: null,
        title: 'Should not be created',
        templateId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
