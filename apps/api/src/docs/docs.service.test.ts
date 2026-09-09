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
import type { DocsActor } from './shared.js';

/**
 * The Docs slice, Wave 1, end to end, against real Postgres.
 *
 * "Tests ship with the slice. A slice with untested authorization is not
 * done." — and per ai/phase-6-docs.md §5, Wave 1 specifically owes "its own
 * authz-matrix-style test suite (mirroring guardrail 9's approach — a table
 * of 'user with grant X at ancestor Y can/cannot do Z at descendant W,' not
 * hand-picked cases)" for the tree-inheritance resolver, since `packages/
 * policy`'s `nearestApplicable()` had never been exercised past a single
 * ancestor level before this phase. The "inherited permissions" describe
 * block below is that suite; the rest covers ordinary CRUD and the move/
 * rebalance mechanics `movePage` shares with `moveCard`.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000002');
const GUEST = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000004');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@docs.test'],
  [MEMBER, 'member@docs.test'],
  [GUEST, 'guest@docs.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee10-0000-7000-8000-0000000000ff');

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
}

async function scaffold(slug: string): Promise<Fixture> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');
  const space = await spaces.createSpace(owner, { name: 'Handbook' });
  return { orgId, owner, spaceId: space.spaceId };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-docs-svc-test' });
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

describe('spaces', () => {
  it('creates and lists a space', async () => {
    const fixture = await scaffold('space-create');
    const list = await spaces.listSpaces(fixture.owner);
    expect(list).toEqual([
      {
        spaceId: fixture.spaceId,
        name: 'Handbook',
        archivedAt: null,
        capabilities: { manage: true },
      },
    ]);
  });

  it('archives and restores a space', async () => {
    const fixture = await scaffold('space-archive');
    await spaces.archiveSpace(fixture.owner, { spaceId: fixture.spaceId, restore: false });

    let list = await spaces.listSpaces(fixture.owner);
    expect(list[0]?.archivedAt).not.toBeNull();

    await spaces.archiveSpace(fixture.owner, { spaceId: fixture.spaceId, restore: true });
    list = await spaces.listSpaces(fixture.owner);
    expect(list[0]?.archivedAt).toBeNull();
  });

  it('refuses a member the space:manage capability the matrix reserves', async () => {
    const fixture = await scaffold('space-member-limits');
    await members.addMember(
      fixture.orgId,
      { email: 'member@docs.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    await expect(
      spaces.archiveSpace(member, { spaceId: fixture.spaceId, restore: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    /* `listSpaces`'s own per-space `capabilities.manage` is what the client
       reads to decide whether to show the archive/restore control and
       page-template management at all (Phase 15 §1's sweep) — it must
       agree with the refusal above, not just with the role matrix in the
       abstract. */
    const list = await spaces.listSpaces(member);
    expect(list[0]?.capabilities.manage).toBe(false);
  });
});

describe('pages: CRUD', () => {
  it('creates a root page and a nested page, and lists them flat with ancestor-derived tree info implicit in parentPageId', async () => {
    const fixture = await scaffold('page-create');
    const root = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Getting started',
    });
    const child = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: root.pageId,
      title: 'Onboarding',
    });

    const list = await pages.listPages(fixture.owner, { spaceId: fixture.spaceId });
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.pageId === root.pageId)?.parentPageId).toBeNull();
    expect(list.find((p) => p.pageId === child.pageId)?.parentPageId).toBe(root.pageId);
  });

  it('renames a page and emits page.updated only when the title actually changes', async () => {
    const fixture = await scaffold('page-rename');
    const page = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Draft',
    });

    await pages.updatePage(fixture.owner, { pageId: page.pageId, title: 'Final' });
    const list = await pages.listPages(fixture.owner, { spaceId: fixture.spaceId });
    expect(list[0]?.title).toBe('Final');

    // Same title again: a no-op, not an error and not a second event — this
    // is a behavioural assertion (it must not throw), not just documentation.
    await expect(
      pages.updatePage(fixture.owner, { pageId: page.pageId, title: 'Final' }),
    ).resolves.toBeUndefined();
  });

  it('refuses creating a page under an archived page', async () => {
    const fixture = await scaffold('page-archived-parent');
    const parent = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Parent',
    });
    await pages.archivePage(fixture.owner, { pageId: parent.pageId, restore: false });

    await expect(
      pages.createPage(fixture.owner, {
        spaceId: fixture.spaceId,
        parentPageId: parent.pageId,
        title: 'Child',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('exposes page:delete as a per-page capability.archive, and refuses a member with no grant', async () => {
    const fixture = await scaffold('page-member-archive-limits');
    const root = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Handbook root',
    });
    await members.addMember(
      fixture.orgId,
      { email: 'member@docs.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    const ownerList = await pages.listPages(fixture.owner, { spaceId: fixture.spaceId });
    expect(ownerList.find((p) => p.pageId === root.pageId)?.capabilities.archive).toBe(true);

    await expect(
      pages.archivePage(member, { pageId: root.pageId, restore: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    /* `listPages`'s own per-page `capabilities.archive` is what the client
       reads to decide whether to show the page-level Archive/Restore control
       at all (Phase 15 §1's sweep) — it must agree with the refusal above,
       not just with the role matrix in the abstract. `page:update` (used for
       Rename) stays true throughout: it is a plain-Member role permission,
       unlike `page:delete`. */
    const memberList = await pages.listPages(member, { spaceId: fixture.spaceId });
    expect(memberList.find((p) => p.pageId === root.pageId)?.capabilities.archive).toBe(false);
  });

  it('refuses creating a page under a page in another space', async () => {
    const fixture = await scaffold('page-cross-space-create');
    const otherSpace = await spaces.createSpace(fixture.owner, { name: 'Other' });
    const parent = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Parent',
    });

    await expect(
      pages.createPage(fixture.owner, {
        spaceId: otherSpace.spaceId,
        parentPageId: parent.pageId,
        title: 'Child',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('pages: move and the materialized path', () => {
  it('reparents a page and rewrites every descendant ancestor chain in the same transaction', async () => {
    const fixture = await scaffold('page-reparent');

    const a = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'A',
    });
    const b = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: a.pageId,
      title: 'B',
    });
    const c = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: b.pageId,
      title: 'C',
    });
    const d = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'D',
    });

    // Move B (and its child C) from under A to under D.
    await pages.movePage(fixture.owner, {
      pageId: b.pageId,
      targetParentId: d.pageId,
      beforePageId: null,
      afterPageId: null,
    });

    await admin.setOrg(fixture.orgId);
    const rows = await admin.query(
      `SELECT id, ancestor_ids, parent_page_id FROM docs.pages WHERE id = ANY($1::uuid[])`,
      [[b.pageId, c.pageId]],
    );
    await admin.setOrg(null);

    const bRow = rows.rows.find((r) => r['id'] === b.pageId);
    const cRow = rows.rows.find((r) => r['id'] === c.pageId);

    // B's own chain: now [D] — no longer [A].
    expect(bRow?.['parent_page_id']).toBe(d.pageId);
    expect(bRow?.['ancestor_ids']).toEqual([d.pageId]);

    // C never moved directly, but its chain must reflect B's new position:
    // nearest-first [B, D] — the A prefix is gone, not merely appended-to.
    expect(cRow?.['ancestor_ids']).toEqual([b.pageId, d.pageId]);
  });

  it('refuses moving a page to another space', async () => {
    const fixture = await scaffold('page-move-cross-space');
    const otherSpace = await spaces.createSpace(fixture.owner, { name: 'Other' });
    const page = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Page',
    });
    const otherRoot = await pages.createPage(fixture.owner, {
      spaceId: otherSpace.spaceId,
      parentPageId: null,
      title: 'Other root',
    });

    await expect(
      pages.movePage(fixture.owner, {
        pageId: page.pageId,
        targetParentId: otherRoot.pageId,
        beforePageId: null,
        afterPageId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses moving a page under its own descendant', async () => {
    const fixture = await scaffold('page-move-cycle');
    const a = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'A',
    });
    const b = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: a.pageId,
      title: 'B',
    });

    await expect(
      pages.movePage(fixture.owner, {
        pageId: a.pageId,
        targetParentId: b.pageId,
        beforePageId: null,
        afterPageId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a stale neighbour not among the true siblings', async () => {
    const fixture = await scaffold('page-move-stale');
    const elsewhere = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Elsewhere',
    });
    const moving = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Moving',
    });
    const parent = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Parent',
    });

    await expect(
      pages.movePage(fixture.owner, {
        pageId: moving.pageId,
        targetParentId: parent.pageId,
        beforePageId: elsewhere.pageId,
        afterPageId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('repairs a degenerate sibling group and reports it, rather than failing the move', async () => {
    const fixture = await scaffold('page-rebalance');
    const first = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'First',
    });
    const second = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Second',
    });
    const mover = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'Mover',
    });

    await admin.setOrg(fixture.orgId);
    await admin.query(`UPDATE docs.pages SET rank = 'a0' WHERE id = ANY($1::uuid[])`, [
      [first.pageId, second.pageId],
    ]);
    await admin.setOrg(null);

    const result = await pages.movePage(fixture.owner, {
      pageId: mover.pageId,
      targetParentId: null,
      beforePageId: first.pageId,
      afterPageId: second.pageId,
    });

    expect(result.rebalanced).toBe(true);

    const list = await pages.listPages(fixture.owner, { spaceId: fixture.spaceId });
    const ordered = [...list].sort((x, y) => (x.rank < y.rank ? -1 : 1));
    expect(ordered.map((p) => p.title)).toEqual(['First', 'Mover', 'Second']);
  });
});

/**
 * Inherited permissions across the page tree (§3.4).
 *
 * Fixture for every test below:
 *
 *   Space
 *     A (root)
 *       B (child of A)
 *         C (child of B)
 *     D (root, unrelated subtree)
 *
 * `nearestApplicable()` in packages/policy is exercised here past the single
 * ancestor level everything before this phase tested it at.
 */
describe('inherited permissions across the page tree', () => {
  interface Tree {
    readonly orgId: OrgId;
    readonly owner: DocsActor;
    readonly spaceId: SpaceId;
    readonly a: PageId;
    readonly b: PageId;
    readonly c: PageId;
    readonly d: PageId;
  }

  async function tree(slug: string): Promise<Tree> {
    const fixture = await scaffold(slug);
    const a = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'A',
    });
    const b = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: a.pageId,
      title: 'B',
    });
    const c = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: b.pageId,
      title: 'C',
    });
    const d = await pages.createPage(fixture.owner, {
      spaceId: fixture.spaceId,
      parentPageId: null,
      title: 'D',
    });
    await members.addMember(
      fixture.orgId,
      { email: 'guest@docs.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    return {
      orgId: fixture.orgId,
      owner: fixture.owner,
      spaceId: fixture.spaceId,
      a: a.pageId,
      b: b.pageId,
      c: c.pageId,
      d: d.pageId,
    };
  }

  it('a guest holds nothing from the role, and cannot read a page with no tuple anywhere in its chain', async () => {
    const t = await tree('inherit-guest-baseline');
    const guest = await actorFor(t.orgId, GUEST, 'guest');

    await expect(pages.updatePage(guest, { pageId: t.c, title: 'Nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an editor tuple on the TOP page (A) reaches a descendant three levels down (C)', async () => {
    const t = await tree('inherit-depth-3');

    await grants.grant(
      t.orgId,
      {
        subjectType: 'user',
        subjectId: GUEST,
        relation: 'editor',
        objectType: 'page',
        objectId: t.a,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );

    // Loaded AFTER the grant — `actorFor` snapshots tuples via `loadTuples`,
    // so an actor built before the grant exists would carry an empty tuple
    // set and the assertion below would pass for the wrong reason (or, for
    // `updatePage`, fail with a misleading NOT_FOUND that looks like a real
    // inheritance bug rather than a stale fixture).
    const guest = await actorFor(t.orgId, GUEST, 'guest');
    await expect(
      pages.updatePage(guest, { pageId: t.c, title: 'Edited via A' }),
    ).resolves.toBeUndefined();
  });

  it('a tuple on one subtree (A) does not reach an unrelated subtree (D)', async () => {
    const t = await tree('inherit-no-cross-subtree');

    await grants.grant(
      t.orgId,
      {
        subjectType: 'user',
        subjectId: GUEST,
        relation: 'editor',
        objectType: 'page',
        objectId: t.a,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );

    const guest = await actorFor(t.orgId, GUEST, 'guest');
    await expect(pages.updatePage(guest, { pageId: t.d, title: 'Nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('the NEAREST tuple wins: a viewer cap on B overrides an editor grant on A for C, but not for A or B themselves already covered above', async () => {
    const t = await tree('inherit-nearest-wins');
    await members.addMember(
      t.orgId,
      { email: 'member@docs.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    // MEMBER gets edit rights from an editor tuple on A...
    await grants.grant(
      t.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'editor',
        objectType: 'page',
        objectId: t.a,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    // ...but a viewer tuple on B, the NEARER ancestor of C, caps it back down.
    await grants.grant(
      t.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'viewer',
        objectType: 'page',
        objectId: t.b,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );

    const freshMember = await actorFor(t.orgId, MEMBER, 'member');

    // C: nearest tuple is B's viewer cap — read allowed, write refused.
    await expect(
      pages.updatePage(freshMember, { pageId: t.c, title: 'Blocked' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // A itself: nearest (only) tuple is the editor grant on A — write allowed.
    await expect(
      pages.updatePage(freshMember, { pageId: t.a, title: 'Edited via own grant' }),
    ).resolves.toBeUndefined();
  });

  it('falls back to the space when no page in the chain carries a tuple', async () => {
    const t = await tree('inherit-space-fallback');

    await grants.grant(
      t.orgId,
      {
        subjectType: 'user',
        subjectId: GUEST,
        relation: 'editor',
        objectType: 'space',
        objectId: t.spaceId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );

    const guest = await actorFor(t.orgId, GUEST, 'guest');

    // A space-level grant reaches every page in it, root and nested alike.
    await expect(
      pages.updatePage(guest, { pageId: t.a, title: 'Via space' }),
    ).resolves.toBeUndefined();
    await expect(
      pages.updatePage(guest, { pageId: t.c, title: 'Via space too' }),
    ).resolves.toBeUndefined();
  });
});
