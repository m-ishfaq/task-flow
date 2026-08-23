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
import { signAccessToken } from '@taskflow/security';
import { authorizeConnect } from './authorize.js';
import { authenticateConnection, CollabAuthError } from './auth.js';
import { pageDocumentName } from './document-name.js';

/**
 * The collab gateway's authorization spine, end to end against real
 * Postgres (ai/phase-6-docs.md §3.3, §3.4, Wave 1).
 *
 * ⚠ Human-review surface, same standard as `apps/realtime`'s room-join
 * coverage: `authorizeConnect` REFUSES rather than silently downgrading
 * (§3.3's own words), and `authenticateConnection` composes token
 * verification with it correctly. A page's inherited-permission RESOLUTION
 * itself is already proven at genuine tree depth by
 * `apps/api/src/docs/docs.service.test.ts` — this file's job is what is
 * specific to a socket-shaped entry point: org selection via a
 * client-supplied parameter, document-name parsing, and read-only vs.
 * refused-outright.
 *
 * Fixtures are seeded with direct SQL through the migrator connection rather
 * than through `apps/api`'s own service functions, deliberately: those
 * functions live inside `apps/api`'s package boundary and are not (and
 * should not become) part of its public surface just to make a sibling
 * app's test fixture more convenient — `@taskflow/api/tenancy/resolve` and
 * `@taskflow/api/docs/page` are the two exports this app's PRODUCTION code
 * actually depends on, and the fixture setup below does not need to grow
 * that list. The org/membership/space/page/tuple machinery those raw
 * inserts stand in for is independently proven correct by `apps/api`'s own
 * suites.
 */

const SECRET = Buffer.alloc(32, 2);
const ORIGINS = ['http://localhost:5173'];

const OWNER = unsafeAsId<'UserId'>('0195ff30-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ff30-0000-7000-8000-000000000002');
const GUEST = unsafeAsId<'UserId'>('0195ff30-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@collab.test'],
  [MEMBER, 'member@collab.test'],
  [GUEST, 'guest@collab.test'],
];

let admin: AdminConnection;
let created: OrgId[] = [];

async function token(userId: UserId): Promise<string> {
  return signAccessToken(
    {
      userId,
      sessionId: '0195ff30-0000-7000-8000-000000000501',
      authenticatedAt: Math.floor(Date.now() / 1000),
    },
    { secret: SECRET },
  );
}

interface Tree {
  readonly orgId: OrgId;
  readonly spaceId: SpaceId;
  readonly pageId: PageId;
}

/** An org with one member (role `member`), one guest (role `guest`), one space, one page. */
async function scaffold(slug: string): Promise<Tree> {
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const spaceId = unsafeAsId<'SpaceId'>(crypto.randomUUID());
  const pageId = unsafeAsId<'PageId'>(crypto.randomUUID());

  // Every table here is RLS-protected with FORCE ROW LEVEL SECURITY, which
  // binds even the migrator — `app.org_id` has to equal the row's own org_id
  // to satisfy WITH CHECK, including on the very INSERT that creates the org
  // itself. `org.service.ts`'s real `createOrg` gets this for free from
  // `withOrgScope(orgId, ...)`; the raw-SQL equivalent is setting it first.
  await admin.setOrg(orgId);

  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `collab-${slug}-${orgId.slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [crypto.randomUUID(), orgId, OWNER],
  );
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
    [crypto.randomUUID(), orgId, MEMBER],
  );
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'guest')`,
    [crypto.randomUUID(), orgId, GUEST],
  );

  await admin.query(
    `INSERT INTO docs.spaces (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)`,
    [spaceId, orgId, 'Handbook', OWNER],
  );
  await admin.query(
    `INSERT INTO docs.pages (id, org_id, space_id, parent_page_id, title, rank, ancestor_ids, created_by)
     VALUES ($1, $2, $3, NULL, $4, 'a0', '{}', $5)`,
    [pageId, orgId, spaceId, 'Getting started', OWNER],
  );
  await admin.setOrg(null);

  created.push(orgId);
  return { orgId, spaceId, pageId };
}

async function grantTuple(
  orgId: OrgId,
  subjectId: UserId,
  relation: string,
  objectType: 'page' | 'space',
  objectId: string,
): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO authz.relationship_tuples (id, org_id, subject_type, subject_id, relation, object_type, object_id, granted_by)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, $7)`,
    [crypto.randomUUID(), orgId, subjectId, relation, objectType, objectId, OWNER],
  );
  await admin.setOrg(null);
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM docs.pages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.spaces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
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
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-collab-svc-test',
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

describe('authorizeConnect', () => {
  it('refuses outright when the caller is not a member of the named org', async () => {
    const t = await scaffold('not-member');
    const someoneElsesOrg = unsafeAsId<'OrgId'>(crypto.randomUUID());

    const result = await authorizeConnect(GUEST, someoneElsesOrg, t.pageId);
    expect(result).toMatchObject({ allowed: false, readOnly: true, reason: 'not_a_member' });
  });

  it('refuses outright when the page does not exist', async () => {
    const t = await scaffold('no-page');
    const bogusPage = unsafeAsId<'PageId'>(crypto.randomUUID());

    const result = await authorizeConnect(MEMBER, t.orgId, bogusPage);
    expect(result).toMatchObject({ allowed: false, readOnly: true, reason: 'no_such_page' });
  });

  it('refuses outright a guest with no tuple anywhere in the chain — never a silent read-only downgrade', async () => {
    const t = await scaffold('guest-no-tuple');

    const result = await authorizeConnect(GUEST, t.orgId, t.pageId);
    expect(result).toMatchObject({ allowed: false, readOnly: true, reason: 'denied' });
  });

  it('allows a MEMBER full write access from the role alone', async () => {
    const t = await scaffold('member-role');

    const result = await authorizeConnect(MEMBER, t.orgId, t.pageId);
    expect(result).toMatchObject({ allowed: true, readOnly: false, reason: 'granted' });
  });

  it('allows a guest read-only when their tuple is a viewer, not refused', async () => {
    const t = await scaffold('guest-viewer');
    await grantTuple(t.orgId, GUEST, 'viewer', 'page', t.pageId);

    const result = await authorizeConnect(GUEST, t.orgId, t.pageId);
    expect(result).toMatchObject({ allowed: true, readOnly: true, reason: 'granted' });
  });

  it('allows a guest full write when their tuple is an editor', async () => {
    const t = await scaffold('guest-editor');
    await grantTuple(t.orgId, GUEST, 'editor', 'page', t.pageId);

    const result = await authorizeConnect(GUEST, t.orgId, t.pageId);
    expect(result).toMatchObject({ allowed: true, readOnly: false, reason: 'granted' });
  });

  it('caps a MEMBER to read-only when a viewer tuple sits on the page', async () => {
    // The worked example from packages/policy's decide.ts, replayed for a
    // page: the role grants write, the restrictive relation on THIS resource
    // takes it back.
    const t = await scaffold('member-capped');
    await grantTuple(t.orgId, MEMBER, 'viewer', 'page', t.pageId);

    const result = await authorizeConnect(MEMBER, t.orgId, t.pageId);
    expect(result).toMatchObject({ allowed: true, readOnly: true, reason: 'granted' });
  });
});

describe('authenticateConnection', () => {
  it('composes token verification with authorizeConnect end to end', async () => {
    const t = await scaffold('e2e-allowed');

    const connection = await authenticateConnection(
      {
        token: await token(MEMBER),
        documentName: pageDocumentName(t.pageId),
        origin: ORIGINS[0] ?? null,
        orgIdParam: t.orgId,
        nativeClientHeader: null,
        host: null,
      },
      { jwtSecret: SECRET, allowedOrigins: ORIGINS },
    );

    expect(connection.userId).toBe(MEMBER);
    expect(connection.pageId).toBe(t.pageId);
    expect(connection.readOnly).toBe(false);
  });

  it('refuses a disallowed origin before ever looking at the token', async () => {
    const t = await scaffold('e2e-origin');

    await expect(
      authenticateConnection(
        {
          token: await token(MEMBER),
          documentName: pageDocumentName(t.pageId),
          origin: 'http://evil.test',
          orgIdParam: t.orgId,
          nativeClientHeader: null,
          host: null,
        },
        { jwtSecret: SECRET, allowedOrigins: ORIGINS },
      ),
    ).rejects.toMatchObject({ refusal: 'forbidden_origin' });
  });

  it('refuses a document name that is not a well-formed page reference', async () => {
    const t = await scaffold('e2e-bad-doc');

    await expect(
      authenticateConnection(
        {
          token: await token(MEMBER),
          documentName: 'not-a-page-document',
          origin: ORIGINS[0] ?? null,
          orgIdParam: t.orgId,
          nativeClientHeader: null,
          host: null,
        },
        { jwtSecret: SECRET, allowedOrigins: ORIGINS },
      ),
    ).rejects.toMatchObject({ refusal: 'invalid_document' });
  });

  it('refuses when authorization denies, wrapping the refusal uniformly', async () => {
    const t = await scaffold('e2e-denied');

    await expect(
      authenticateConnection(
        {
          token: await token(GUEST),
          documentName: pageDocumentName(t.pageId),
          origin: ORIGINS[0] ?? null,
          orgIdParam: t.orgId,
          nativeClientHeader: null,
          host: null,
        },
        { jwtSecret: SECRET, allowedOrigins: ORIGINS },
      ),
    ).rejects.toBeInstanceOf(CollabAuthError);
  });
});
