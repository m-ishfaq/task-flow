import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import * as publish from './publish.service.js';
import type { DocsActor } from './shared.js';

/**
 * Publish-to-public (ai/phase-6-docs.md §3.9, Wave 4), the API-side half.
 *
 * What the public HTTP route actually returns to an anonymous caller is
 * `public.routes.test.ts`'s job, not this file's — this suite covers the
 * authorization floor (`page:publish` is admin/owner only, and — per
 * `packages/policy/src/tuples.ts`'s relation grant sets, none of which
 * include a `publish` action — NOT reachable through any per-page tuple
 * either, so an `editor` on the page still cannot publish it) and the
 * column-level contract `public.routes.ts` depends on: publishing writes a
 * NEW 'publish'-kind snapshot and repoints `published_version_id`, and
 * unpublishing clears the pointer without touching version history.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee21-0000-7000-8000-000000000101');
const ADMIN = unsafeAsId<'UserId'>('0195ee21-0000-7000-8000-000000000102');
const MEMBER = unsafeAsId<'UserId'>('0195ee21-0000-7000-8000-000000000103');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@publish.test'],
  [ADMIN, 'admin@publish.test'],
  [MEMBER, 'member@publish.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee21-0000-7000-8000-0000000001ff');

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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-docs-publish-test' });
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

describe('publishPage', () => {
  it('writes a publish-kind snapshot, repoints the page, and emits page.published', async () => {
    const fixture = await scaffold('publish-basic');

    const { versionId } = await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const pageRows = await admin.query(
      `SELECT published_at, published_version_id FROM docs.pages WHERE id = $1`,
      [fixture.pageId],
    );
    const versionRows = await admin.query(`SELECT kind FROM docs.page_versions WHERE id = $1`, [
      versionId,
    ]);
    const outbox = await admin.query(
      `SELECT payload FROM platform.outbox WHERE org_id = $1 AND name = 'page.published'`,
      [fixture.orgId],
    );
    await admin.setOrg(null);

    const pageRow = pageRows.rows[0] as { published_at: Date | null; published_version_id: string };
    expect(pageRow.published_at).not.toBeNull();
    expect(pageRow.published_version_id).toBe(versionId);
    expect((versionRows.rows[0] as { kind: string }).kind).toBe('publish');
    expect(outbox.rows).toHaveLength(1);
    expect((outbox.rows[0]?.['payload'] as { versionId?: string }).versionId).toBe(versionId);
  });

  it('re-publishing writes a NEW snapshot and repoints the pointer, leaving the old snapshot as history', async () => {
    const fixture = await scaffold('publish-again');

    const first = await publish.publishPage(fixture.owner, { pageId: fixture.pageId });
    const second = await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    expect(second.versionId).not.toBe(first.versionId);

    await admin.setOrg(fixture.orgId);
    const pageRows = await admin.query(
      `SELECT published_version_id FROM docs.pages WHERE id = $1`,
      [fixture.pageId],
    );
    const versionRows = await admin.query(
      `SELECT id FROM docs.page_versions WHERE page_id = $1 AND kind = 'publish'`,
      [fixture.pageId],
    );
    await admin.setOrg(null);

    expect((pageRows.rows[0] as { published_version_id: string }).published_version_id).toBe(
      second.versionId,
    );
    // Both publish snapshots still exist — re-publishing never deletes history.
    expect(versionRows.rows.map((r) => (r as { id: string }).id).sort()).toEqual(
      [first.versionId, second.versionId].sort(),
    );
  });

  it('an admin may publish', async () => {
    const fixture = await scaffold('publish-admin');
    await members.addMember(
      fixture.orgId,
      { email: 'admin@publish.test', role: 'admin' },
      { userId: OWNER, requestId },
    );
    const admActor = await actorFor(fixture.orgId, ADMIN, 'admin');

    await expect(publish.publishPage(admActor, { pageId: fixture.pageId })).resolves.toMatchObject({
      versionId: expect.any(String) as string,
    });
  });

  it('a plain member is refused, even though they hold page:create/page:update', async () => {
    const fixture = await scaffold('publish-member-forbidden');
    await members.addMember(
      fixture.orgId,
      { email: 'member@publish.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const memberActor = await actorFor(fixture.orgId, MEMBER, 'member');

    await expect(
      publish.publishPage(memberActor, { pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an editor-tuple guest is refused — no relation grants a publish action (packages/policy/src/tuples.ts)', async () => {
    const fixture = await scaffold('publish-editor-tuple-forbidden');
    await members.addMember(
      fixture.orgId,
      { email: 'member@publish.test', role: 'guest' },
      { userId: OWNER, requestId },
    );

    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'editor',
        objectType: 'page',
        objectId: fixture.pageId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, MEMBER, 'guest');

    await expect(publish.publishPage(guest, { pageId: fixture.pageId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('unpublishPage', () => {
  it('clears the pointer and timestamp, leaves the snapshot row alone, and emits page.unpublished', async () => {
    const fixture = await scaffold('unpublish-basic');
    const { versionId } = await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    await publish.unpublishPage(fixture.owner, { pageId: fixture.pageId });

    await admin.setOrg(fixture.orgId);
    const pageRows = await admin.query(
      `SELECT published_at, published_version_id FROM docs.pages WHERE id = $1`,
      [fixture.pageId],
    );
    const versionRows = await admin.query(`SELECT id FROM docs.page_versions WHERE id = $1`, [
      versionId,
    ]);
    const outbox = await admin.query(
      `SELECT id FROM platform.outbox WHERE org_id = $1 AND name = 'page.unpublished'`,
      [fixture.orgId],
    );
    await admin.setOrg(null);

    const pageRow = pageRows.rows[0] as {
      published_at: Date | null;
      published_version_id: string | null;
    };
    expect(pageRow.published_at).toBeNull();
    expect(pageRow.published_version_id).toBeNull();
    // The snapshot itself is untouched — unpublish is a visibility change, not a deletion.
    expect(versionRows.rows).toHaveLength(1);
    expect(outbox.rows).toHaveLength(1);
  });

  it('a plain member is refused', async () => {
    const fixture = await scaffold('unpublish-member-forbidden');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });
    await members.addMember(
      fixture.orgId,
      { email: 'member@publish.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const memberActor = await actorFor(fixture.orgId, MEMBER, 'member');

    await expect(
      publish.unpublishPage(memberActor, { pageId: fixture.pageId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
