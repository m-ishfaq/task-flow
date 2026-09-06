import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../../testing/fixtures.js';
import * as orgs from '../../tenancy/org.service.js';
import { loadTuples } from '../../tenancy/resolve.js';
import * as spaces from '../../docs/space.service.js';
import type { DocsActor } from '../../docs/shared.js';
import { createDocsCreatePageTool } from './docs.js';
import type { ToolContext } from './registry.js';

/**
 * `docs.create_page` (§4.1's table, §6's own bootstrap prerequisite),
 * against real Postgres.
 */

const OWNER = unsafeAsId<'UserId'>('0195f800-0000-7000-8000-000000000001');
const requestId: RequestId = unsafeAsId<'RequestId'>('0195f800-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
    'platform.outbox',
    'docs.pages',
    'docs.spaces',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function ownerSubject(orgId: OrgId): Promise<Subject> {
  const tuples = await loadTuples(orgId, OWNER);
  return { orgId, userId: OWNER, role: 'owner', tuples };
}

async function ownerActor(orgId: OrgId): Promise<DocsActor> {
  return { subject: await ownerSubject(orgId), requestId };
}

function guestCtx(orgId: OrgId): ToolContext {
  return { subject: { orgId, userId: OWNER, role: 'guest', tuples: [] }, requestId };
}

function ownerCtx(subject: Subject): ToolContext {
  return { subject, requestId };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@ai-docs-tools.test', 'owner@ai-docs-tools.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-docs-tools-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('docs.create_page', () => {
  it('creates a real, empty, titled page for an owner', async () => {
    const orgId = await newOrg('docs-create-owner');
    const actor = await ownerActor(orgId);
    const space = await spaces.createSpace(actor, { name: 'Handbook' });
    const subject = await ownerSubject(orgId);

    const tool = createDocsCreatePageTool();
    const result = await tool.execute(ownerCtx(subject), {
      spaceId: space.spaceId,
      title: 'Onboarding Checklist',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { pageId: string };

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT title, parent_page_id FROM docs.pages WHERE id = $1`, [
      parsed.pageId,
    ]);
    await admin.setOrg(null);
    expect(rows.rows[0]).toMatchObject({ title: 'Onboarding Checklist', parent_page_id: null });
  });

  it('creates a page under a parent when one is given', async () => {
    const orgId = await newOrg('docs-create-nested');
    const actor = await ownerActor(orgId);
    const space = await spaces.createSpace(actor, { name: 'Handbook' });
    const subject = await ownerSubject(orgId);

    const tool = createDocsCreatePageTool();
    const parent = await tool.execute(ownerCtx(subject), {
      spaceId: space.spaceId,
      title: 'Engineering Wiki',
    });
    const parentId = (JSON.parse(parent.content) as { pageId: string }).pageId;

    const child = await tool.execute(ownerCtx(subject), {
      spaceId: space.spaceId,
      parentPageId: parentId,
      title: 'On-call Runbook',
    });

    expect(child.isError).toBeUndefined();
    const parsed = JSON.parse(child.content) as { pageId: string };

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT parent_page_id FROM docs.pages WHERE id = $1`, [
      parsed.pageId,
    ]);
    await admin.setOrg(null);
    expect(rows.rows[0]?.['parent_page_id']).toBe(parentId);
  });

  it('refuses a guest, who holds page:create from no role by design', async () => {
    const orgId = await newOrg('docs-create-guest');
    const actor = await ownerActor(orgId);
    const space = await spaces.createSpace(actor, { name: 'Handbook' });

    const tool = createDocsCreatePageTool();
    const result = await tool.execute(guestCtx(orgId), {
      spaceId: space.spaceId,
      title: 'Should not exist',
    });

    expect(result.isError).toBe(true);

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT id FROM docs.pages WHERE org_id = $1`, [orgId]);
    await admin.setOrg(null);
    expect(rows.rowCount).toBe(0);
  });

  it('declares requiresConfirmation: true', () => {
    expect(createDocsCreatePageTool().requiresConfirmation).toBe(true);
  });
});
