import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
import { buildServer } from '../server.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as spaces from './space.service.js';
import * as pages from './page.service.js';
import * as publish from './publish.service.js';
import type { DocsActor } from './shared.js';

/**
 * The public docs route, end to end (ai/phase-6-docs.md §3.9, Wave 4).
 *
 * `app.inject()`, matching `server.test.ts`'s own reasoning: this is the one
 * suite that actually exercises `withGlobalScope` plus the `*_public_read`
 * RLS policies (migration 0026) through the real, unauthenticated HTTP path
 * — no `Authorization` header, no `x-taskflow-org` header, exactly what an
 * anonymous request looks like. A test that called `publish.service.ts`
 * directly and then asserted on a DB row would prove the service wrote the
 * right columns; it would prove nothing about whether an anonymous caller
 * can actually READ them, which is the entire point of this file existing.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000101');

const USERS: readonly [UserId, string][] = [[OWNER, 'owner@publicdocs.test']];

const requestId = unsafeAsId<'RequestId'>('0195ee20-0000-7000-8000-0000000001ff');

let admin: AdminConnection;
let app: FastifyInstance;
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
    title: 'Public Runbook',
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-docs-public-test' });
  app = await buildServer({ env: TEST_ENV, deliver: () => Promise.resolve() });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await app.close();
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('GET /public/docs/pages/:pageId', () => {
  it('404s for a page that was never published — no session, no leak', async () => {
    const fixture = await scaffold('never-published');

    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${fixture.pageId}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s for a page id that does not exist at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${crypto.randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('serves the published title and body with no Authorization header', async () => {
    const fixture = await scaffold('published');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${fixture.pageId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Public Runbook');
  });

  it('404s again once the page is unpublished — the pointer, not the row, is what public read follows', async () => {
    const fixture = await scaffold('unpublished-after');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });
    await publish.unpublishPage(fixture.owner, { pageId: fixture.pageId });

    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${fixture.pageId}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s for an archived page even if it was published first', async () => {
    const fixture = await scaffold('archived-after-publish');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });
    await pages.archivePage(fixture.owner, { pageId: fixture.pageId, restore: false });

    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${fixture.pageId}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('one org publishing a page never makes a SECOND org’s unpublished page visible', async () => {
    const published = await scaffold('tenant-a-published');
    const other = await scaffold('tenant-b-unpublished');
    await publish.publishPage(published.owner, { pageId: published.pageId });

    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${other.pageId}`,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /public/docs/pages/:pageId/export.pdf', () => {
  it('404s for an unpublished page', async () => {
    const fixture = await scaffold('pdf-unpublished');

    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${fixture.pageId}/export.pdf`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('serves a PDF for a published page', async () => {
    const fixture = await scaffold('pdf-published');
    await publish.publishPage(fixture.owner, { pageId: fixture.pageId });

    const response = await app.inject({
      method: 'GET',
      url: `/public/docs/pages/${fixture.pageId}/export.pdf`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(response.rawPayload).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
