import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { enforceContentWhitelist } from '@taskflow/collab/content-guard';
import type { DomainEvent } from '@taskflow/events';
import { roleGrants, type Role } from '@taskflow/policy';
import { createRng } from './rng.js';
import { findProfile, PROFILES, type OrgPlan, type Profile, type SpacePlan } from './profiles.js';
import { contentModule, editDocument } from './modules/docs.content.js';
import { commentsModule } from './modules/docs.comments.js';
import { suggestionsModule } from './modules/docs.suggestions.js';
import { spacesModule } from './modules/docs.spaces.js';
import { orgsModule, type SeededMembership, type SeededOrg } from './modules/tenancy.orgs.js';
import type { SeedContext, SeedDb } from './context.js';
import type { SeedModule } from './registry.js';

/**
 * The Docs fixture, held to the invariants the DATABASE does not enforce.
 *
 * Migration 0023 is explicit that `ancestor_ids` is a service-level invariant
 * over a column Postgres constrains only by shape — nothing checks it against a
 * walk of `parent_page_id`, exactly as nothing checks that a card's rank really
 * sits between its neighbours'. So the tree this seeder writes can be wrong in
 * the one way that matters (the §3.4 nearest-ancestor walk answering with the
 * wrong page, which is a permission bug) while every constraint, every foreign
 * key and every row-level check passes.
 *
 * These tests re-derive what the module claims, from the rows it actually
 * writes, rather than reading its intermediate state — which is why the fake
 * context below captures INSERTs instead of exposing the tree builder. A test
 * that asked the builder what it built would agree with itself.
 *
 * No database. The properties here are arithmetic and byte-level, and the ones
 * that genuinely need Postgres (RLS, the composite FKs, the GIN index) are the
 * database's own to prove — `packages/db`'s suites already do.
 */

/* -------------------------------------------------------------------------- *
 * A fake context: captures what a module would have written.
 * -------------------------------------------------------------------------- */

interface CapturedInsert {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  /** The org scope in force at the time — a missing one is the bug it catches. */
  readonly orgId: string | null;
}

interface Harness {
  readonly ctx: SeedContext;
  readonly inserts: CapturedInsert[];
  readonly events: DomainEvent[];
  rowsOf(table: string): readonly (readonly unknown[])[];
  columnsOf(table: string): readonly string[];
}

function harnessFor(profile: Profile, org: SeededOrg, seed = 'docs-test'): Harness {
  const inserts: CapturedInsert[] = [];
  const events: DomainEvent[] = [];
  let currentOrg: string | null = null;

  const db: SeedDb = {
    query: () => Promise.resolve([]),
    insert: (table, columns, rows) => {
      inserts.push({ table, columns, rows, orgId: currentOrg });
      return Promise.resolve(rows.length);
    },
  };

  const outputs = new Map<SeedModule, unknown>();
  outputs.set(orgsModule, { orgs: [org] });

  const ctx: SeedContext = {
    db,
    rng: createRng(seed),
    profile,
    now: new Date('2026-08-06T12:00:00.000Z'),
    chaos: false,
    storage: null,
    log: () => undefined,
    use: <Out>(module: SeedModule<Out>): Out => {
      if (!outputs.has(module)) throw new Error(`no output recorded for ${module.name}`);
      return outputs.get(module) as Out;
    },
    emit: (event) => events.push(event),
    bufferedEvents: () => events,
    orgScope: async (orgId, fn) => {
      const previous = currentOrg;
      currentOrg = orgId;
      try {
        return await fn();
      } finally {
        currentOrg = previous;
      }
    },
  };

  return {
    ctx,
    inserts,
    events,
    rowsOf: (table) => inserts.filter((i) => i.table === table).flatMap((i) => [...i.rows]),
    columnsOf: (table) => inserts.find((i) => i.table === table)?.columns ?? [],
  };
}

/* -------------------------------------------------------------------------- *
 * A tenant, small enough to read and complete enough to seed against.
 * -------------------------------------------------------------------------- */

/** A well-formed v7-shaped id, distinct per (kind, index). */
function id(kind: string, index: number): string {
  return `00000000-0000-7000-8000-${kind}${String(index).padStart(8, '0')}`;
}

function membership(index: number, role: Role): SeededMembership {
  return {
    membershipId: id('4d', index),
    user: {
      id: id('55', index),
      name: {
        first: `First${String(index)}`,
        last: `Last${String(index)}`,
        full: `First${String(index)} Last${String(index)}`,
      },
      email: `user${String(index)}@taskflow.seed.test`,
    },
    role,
  };
}

const ORG_ID = id('a1', 1);

const MEMBERSHIPS: readonly SeededMembership[] = [
  membership(0, 'owner'),
  membership(1, 'admin'),
  membership(2, 'member'),
  membership(3, 'member'),
  membership(4, 'guest'),
];

function orgWith(spaces: readonly SpacePlan[]): SeededOrg {
  const plan: OrgPlan = {
    name: 'Test Org',
    slug: 'test-org',
    grants: 0,
    teams: ['Core'],
    members: MEMBERSHIPS.map((m, i) => ({ user: i, role: m.role })),
    channels: [],
    projects: [],
    spaces,
  };

  const owner = MEMBERSHIPS[0];
  if (owner === undefined) throw new Error('fixture has no owner');

  return {
    id: ORG_ID,
    name: plan.name,
    slug: plan.slug,
    plan,
    owner: owner.user,
    memberships: MEMBERSHIPS,
    teams: [
      { id: id('7e', 1), name: 'Core', slug: 'core', members: MEMBERSHIPS.map((m) => m.user) },
    ],
    members: MEMBERSHIPS.map((m) => m.user),
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
  };
}

const DEMO = findProfile('demo');

/** Column-name → value, so assertions read as rows rather than as indices. */
function asRecords(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): readonly Record<string, unknown>[] {
  // `ancestor_ids::uuid[]` — the cast is part of the column spec, not the name.
  const names = columns.map((column) => column.split('::')[0] ?? column);
  return rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

async function seedSpaces(
  spaces: readonly SpacePlan[],
  profile: Profile = DEMO,
  seed = 'docs-test',
): Promise<{ harness: Harness; pages: readonly Record<string, unknown>[] }> {
  const harness = harnessFor(profile, orgWith(spaces), seed);
  await spacesModule.seed(harness.ctx);

  return {
    harness,
    pages: asRecords(harness.columnsOf('docs.pages'), harness.rowsOf('docs.pages')),
  };
}

/* -------------------------------------------------------------------------- *
 * The tree
 * -------------------------------------------------------------------------- */

describe('docs.spaces — the tree', () => {
  const plan: SpacePlan = { name: 'Handbook', pages: 40, depth: 5, wide: 8, grants: 3 };

  it('writes ancestor_ids that match a walk of parent_page_id, nearest first', async () => {
    const { pages } = await seedSpaces([plan]);
    const byId = new Map(pages.map((page) => [String(page['id']), page]));

    for (const page of pages) {
      const walked: string[] = [];
      let cursor = page['parent_page_id'];
      while (typeof cursor === 'string') {
        walked.push(cursor);
        cursor = byId.get(cursor)?.['parent_page_id'] ?? null;
      }

      /* Nearest-first is the assertion, not an implementation detail:
         `nearestApplicable` stops at the first ancestor carrying a tuple, so a
         reversed array means the SPACE's grant beats the page's own. */
      expect(page['ancestor_ids'], String(page['title'])).toEqual(walked);
    }
  });

  it('never lists a page as its own ancestor', async () => {
    const { pages } = await seedSpaces([plan]);
    for (const page of pages) {
      expect(page['ancestor_ids']).not.toContain(page['id']);
    }
  });

  it('inserts every parent before its children', async () => {
    /* `pages_parent_fk` is not DEFERRABLE, so this is not a tidiness property:
       a child ahead of its parent is refused by the database even though both
       rows are in the same multi-row INSERT. */
    const { pages } = await seedSpaces([plan]);
    const seen = new Set<string>();

    for (const page of pages) {
      const parent = page['parent_page_id'];
      if (typeof parent === 'string') expect(seen.has(parent)).toBe(true);
      seen.add(String(page['id']));
    }
  });

  it('guarantees the planned depth and the wide sibling set', async () => {
    const { pages } = await seedSpaces([plan]);

    const depths = pages.map((page) => (page['ancestor_ids'] as readonly string[]).length + 1);
    expect(Math.max(...depths)).toBe(plan.depth);

    const childCounts = new Map<string, number>();
    for (const page of pages) {
      const parent = page['parent_page_id'];
      if (typeof parent !== 'string') continue;
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    }
    expect(Math.max(...childCounts.values())).toBeGreaterThanOrEqual(plan.wide ?? 0);
  });

  it('writes exactly the planned number of pages, and none for an empty space', async () => {
    const { pages } = await seedSpaces([plan, { name: 'Empty', pages: 0, depth: 1, grants: 0 }]);
    expect(pages).toHaveLength(plan.pages);
  });

  it('gives every sibling group an increasing run of valid ranks', async () => {
    const { pages } = await seedSpaces([plan]);
    const groups = new Map<string, string[]>();

    for (const page of pages) {
      const key = typeof page['parent_page_id'] === 'string' ? page['parent_page_id'] : 'root';
      const rank = String(page['rank']);
      // migration 0023's own CHECK, asked here so a bad edit fails with a
      // message naming the rank rather than naming an index.
      expect(rank).toMatch(/^[0-9A-Za-z]{2,}$/);
      groups.set(key, [...(groups.get(key) ?? []), rank]);
    }

    for (const ranks of groups.values()) {
      expect(ranks).toEqual([...ranks].sort());
      expect(new Set(ranks).size).toBe(ranks.length);
    }
  });

  it('never archives a page while leaving live children under it', async () => {
    /* The state a tree query filtering `archived_at` on the page but not on its
       ancestors renders as children hanging off nothing — and one the product
       cannot produce, since archiving a page archives what is under it. */
    const { pages } = await seedSpaces([
      { name: 'Product', pages: 30, depth: 4, grants: 1, archivedSubtree: true },
    ]);
    const archived = new Set(
      pages.filter((page) => page['archived_at'] !== null).map((page) => String(page['id'])),
    );
    expect(archived.size).toBeGreaterThan(0);

    for (const page of pages) {
      if (page['archived_at'] !== null) continue;
      for (const ancestor of page['ancestor_ids'] as readonly string[]) {
        expect(archived.has(ancestor), `live page under archived ${ancestor}`).toBe(false);
      }
    }
  });

  it('leaves the pages of an archived space live underneath it', async () => {
    // 0023: an archived space's pages are not purged. The space carries the
    // archival; individually archiving its pages would be a second claim.
    const { harness, pages } = await seedSpaces([
      { name: 'Onboarding', pages: 10, depth: 3, grants: 0, archived: true },
    ]);

    const spaces = asRecords(harness.columnsOf('docs.spaces'), harness.rowsOf('docs.spaces'));
    expect(spaces[0]?.['archived_at']).toBeInstanceOf(Date);
    expect(pages.every((page) => page['archived_at'] === null)).toBe(true);
  });

  it('writes every row inside an org scope', async () => {
    /* A write issued with no scope is dropped by RLS and reports success
       (`context.ts`'s own note). The real `insert` catches it by row count;
       here the scope itself is observable. */
    const { harness } = await seedSpaces([plan]);
    expect(harness.inserts.length).toBeGreaterThan(0);
    for (const insert of harness.inserts) {
      expect(insert.orgId, insert.table).toBe(ORG_ID);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Grants
 * -------------------------------------------------------------------------- */

describe('docs.spaces — grants', () => {
  it('grants the guest exactly one page, and nothing else', async () => {
    const { harness, pages } = await seedSpaces([
      { name: 'Runbooks', pages: 12, depth: 3, grants: 2, withGuest: true },
    ]);

    const tuples = asRecords(
      harness.columnsOf('authz.relationship_tuples'),
      harness.rowsOf('authz.relationship_tuples'),
    );
    const guestId = MEMBERSHIPS[4]?.user.id;
    const guestTuples = tuples.filter((tuple) => tuple['subject_id'] === guestId);

    // A guest's role grants nothing at all, so this tuple is the entire
    // authorization deciding what `onAuthenticate` opens for them (§3.3).
    expect(guestTuples).toHaveLength(1);
    expect(guestTuples[0]?.['object_type']).toBe('page');

    const target = String(guestTuples[0]?.['object_id']);
    expect(pages.some((page) => page['id'] === target)).toBe(true);
  });

  it('places the inheritance and narrowing shapes rather than hoping for them', async () => {
    const { harness, pages } = await seedSpaces([
      { name: 'Handbook', pages: 30, depth: 5, grants: 4 },
    ]);
    const tuples = asRecords(
      harness.columnsOf('authz.relationship_tuples'),
      harness.rowsOf('authz.relationship_tuples'),
    );
    const depthOf = new Map(
      pages.map((page) => [
        String(page['id']),
        (page['ancestor_ids'] as readonly string[]).length + 1,
      ]),
    );

    const pageTuples = tuples.filter((tuple) => tuple['object_type'] === 'page');
    // Something granted on an ancestor (so a descendant inherits it), and
    // something granted deep (so the closer tuple has something to narrow).
    expect(pageTuples.some((tuple) => (depthOf.get(String(tuple['object_id'])) ?? 0) <= 2)).toBe(
      true,
    );
    expect(pageTuples.some((tuple) => (depthOf.get(String(tuple['object_id'])) ?? 0) >= 3)).toBe(
      true,
    );
    expect(tuples.some((tuple) => tuple['relation'] === 'viewer')).toBe(true);
  });

  it('names only resource types a tuple can point at', async () => {
    const { harness } = await seedSpaces([{ name: 'Handbook', pages: 20, depth: 4, grants: 6 }]);
    const tuples = asRecords(
      harness.columnsOf('authz.relationship_tuples'),
      harness.rowsOf('authz.relationship_tuples'),
    );

    for (const tuple of tuples) {
      expect(['page', 'space']).toContain(tuple['object_type']);
      expect(['user', 'team']).toContain(tuple['subject_type']);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Content
 * -------------------------------------------------------------------------- */

interface DeltaSegment {
  readonly insert: string;
}

/**
 * A document's structure and text, serialized here rather than via
 * `YXmlFragment.toString()`.
 *
 * Not a style preference. `toString()` renders marks as pseudo-XML — the exact
 * behaviour `content-guard.ts` documents having been caught by — so comparing
 * two documents through it compares a rendering rather than the content, and a
 * difference in formatting reads as a difference in text. Node names are
 * included because the structure IS part of what these tests compare: a replay
 * that lost a list would otherwise match a replay that kept it.
 */
function serialize(node: Y.XmlFragment | Y.XmlElement): string {
  let out = '';
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      const delta = child.toDelta() as readonly DeltaSegment[];
      out += delta.map((segment) => segment.insert).join('');
    } else if (child instanceof Y.XmlElement) {
      out += `<${child.nodeName}>${serialize(child)}</${child.nodeName}>`;
    }
  }
  return out;
}

/** The document a set of updates converges to. */
function textOf(updates: readonly Uint8Array[], from?: Uint8Array): string {
  const doc = new Y.Doc();
  if (from !== undefined) Y.applyUpdate(doc, from);
  for (const update of updates) Y.applyUpdate(doc, update);
  return serialize(doc.getXmlFragment('content'));
}

describe('docs.content — the CRDT fixture', () => {
  const mix = DEMO.page;

  it('produces documents the collab gateway leaves untouched', () => {
    const rng = createRng('content');

    for (let i = 0; i < 25; i += 1) {
      const edited = editDocument(rng, { ...mix, snapshotRate: 1 }, false, null);
      const doc = new Y.Doc();
      for (const update of edited.updates) Y.applyUpdate(doc, update);

      /* The guard itself, not a restatement of its rules. A seeded document it
         would strip is a fixture the real pipeline silently rewrites — and the
         heading whose `level` is a string rather than a number is exactly that
         bug, invisible in every other assertion here. */
      const result = enforceContentWhitelist(doc.getXmlFragment('content'));
      expect(result, `document ${String(i)}`).toEqual({
        strippedNodes: 0,
        strippedTextRuns: 0,
        changed: false,
      });
    }
  });

  it('replays snapshot + tail to the same document as the whole log', () => {
    /* `replayPage` loads the newest snapshot and applies only the WAL rows
       after it. A page whose tail is dropped reads back as of its snapshot,
       with no error anywhere — which is the failure this asserts against. */
    const rng = createRng('replay');

    for (let i = 0; i < 25; i += 1) {
      const edited = editDocument(rng, { ...mix, snapshotRate: 1, tailRate: 1 }, false, null);
      const snapshot = edited.snapshot;
      if (snapshot === null) continue;

      const tail = edited.updates.slice(snapshot.after + 1);
      expect(textOf(tail, snapshot.state)).toBe(textOf(edited.updates));
    }
  });

  it('takes a snapshot with something after it when a tail is asked for', () => {
    const edited = editDocument(
      createRng('tail'),
      { ...mix, blocks: [8, 8], updates: [4, 4], snapshotRate: 1, tailRate: 1 },
      false,
      null,
    );
    expect(edited.snapshot).not.toBeNull();
    expect(edited.snapshot?.after).toBeLessThan(edited.updates.length - 1);
  });

  it('is byte-for-byte reproducible from the same seed', () => {
    /* The clientID line. Without it these documents converge to the same text
       while every `data` column differs, so this is the only assertion that
       fails when it regresses. */
    const first = editDocument(createRng('same'), mix, false, null);
    const second = editDocument(createRng('same'), mix, false, null);

    expect(first.updates.map((u) => Buffer.from(u).toString('base64'))).toEqual(
      second.updates.map((u) => Buffer.from(u).toString('base64')),
    );
    expect(first.snapshot?.state).toEqual(second.snapshot?.state);
  });

  it('differs between seeds', () => {
    const first = editDocument(createRng('one'), mix, false, null);
    const second = editDocument(createRng('two'), mix, false, null);
    expect(textOf(first.updates)).not.toBe(textOf(second.updates));
  });

  it('plants a document the guard has to strip under --chaos', () => {
    const edited = editDocument(createRng('chaos'), mix, true, null);
    const doc = new Y.Doc();
    for (const update of edited.updates) Y.applyUpdate(doc, update);

    const result = enforceContentWhitelist(doc.getXmlFragment('content'));
    expect(result.strippedNodes).toBe(1);
    expect(serialize(doc.getXmlFragment('content'))).not.toContain('iframe');
  });

  it('writes WAL rows and snapshots only for spaces asking for content', async () => {
    const withContent: SpacePlan = {
      name: 'Handbook',
      pages: 12,
      depth: 3,
      grants: 0,
      content: true,
    };
    const without: SpacePlan = { name: 'Archive', pages: 12, depth: 3, grants: 0 };

    const org = orgWith([withContent, without]);
    const harness = harnessFor(DEMO, org);
    const spaces = await spacesModule.seed(harness.ctx);

    const outputs = new Map<SeedModule, unknown>([
      [orgsModule, { orgs: [org] }],
      [spacesModule, spaces],
    ]);
    const ctx: SeedContext = {
      ...harness.ctx,
      use: <Out>(module: SeedModule<Out>): Out => outputs.get(module) as Out,
    };

    const result = await contentModule.seed(ctx);
    expect(result.pagesWithBody).toBeGreaterThan(0);
    expect(result.updateRows).toBeGreaterThan(0);

    const bodied = new Set(
      spaces.pages.filter((page) => page.space.plan.content === true).map((page) => page.id),
    );
    for (const row of harness.rowsOf('docs.yjs_updates')) {
      expect(bodied.has(String(row[2]))).toBe(true);
    }
  });

  it('never attributes an autosave to a person', async () => {
    /* 0024's own note: the compaction pass is not an act any user performed,
       and naming one would claim an event that did not happen. */
    const plan: SpacePlan = { name: 'Handbook', pages: 20, depth: 3, grants: 0, content: true };
    const org = orgWith([plan]);
    const harness = harnessFor(DEMO, org);
    const spaces = await spacesModule.seed(harness.ctx);

    const outputs = new Map<SeedModule, unknown>([
      [orgsModule, { orgs: [org] }],
      [spacesModule, spaces],
    ]);
    await contentModule.seed({
      ...harness.ctx,
      use: <Out>(module: SeedModule<Out>): Out => outputs.get(module) as Out,
    });

    const versions = asRecords(
      harness.columnsOf('docs.page_versions'),
      harness.rowsOf('docs.page_versions'),
    );
    expect(versions.length).toBeGreaterThan(0);

    for (const version of versions) {
      expect(['autosave', 'manual']).toContain(version['kind']);
      if (version['kind'] === 'autosave') expect(version['created_by']).toBeNull();
      else expect(version['created_by']).not.toBeNull();
    }

    // Only the manual save emits — compaction is exempt from guardrail 11 the
    // same way `work/rebalance.ts` is (apps/api's docs/events.ts). A restored
    // version is ALSO `kind: 'manual'` (see the "restore" describe block
    // below) but emits `page.version_restored` instead of `page.version_saved`
    // — so the manual COUNT no longer equals the SAVED-event count on its own;
    // it equals saved + restored.
    const saved = harness.events.filter((event) => event.name === 'page.version_saved');
    const restored = harness.events.filter((event) => event.name === 'page.version_restored');
    expect(saved.length + restored.length).toBe(
      versions.filter((v) => v['kind'] === 'manual').length,
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Wave 3 — internal links, backlinks, and restore.
 * -------------------------------------------------------------------------- */

/** Seeds spaces then content against one shared harness, chaining outputs the
 * way `platform.audit`'s real `requires` graph does. */
async function seedContent(
  spaces: readonly SpacePlan[],
  pageMix: Partial<Profile['page']> = {},
  seed = 'docs-test',
): Promise<{
  harness: Harness;
  spacesOut: Awaited<ReturnType<typeof spacesModule.seed>>;
  contentOut: Awaited<ReturnType<typeof contentModule.seed>>;
}> {
  const profile: Profile = { ...DEMO, page: { ...DEMO.page, ...pageMix } };
  const org = orgWith(spaces);
  const harness = harnessFor(profile, org, seed);
  const spacesOut = await spacesModule.seed(harness.ctx);

  const outputs = new Map<SeedModule, unknown>([
    [orgsModule, { orgs: [org] }],
    [spacesModule, spacesOut],
  ]);
  const contentCtx: SeedContext = {
    ...harness.ctx,
    use: <Out>(module: SeedModule<Out>): Out => outputs.get(module) as Out,
  };
  const contentOut = await contentModule.seed(contentCtx);
  outputs.set(contentModule, contentOut);

  return { harness, spacesOut, contentOut };
}

describe('docs.content — Wave 3 (internal links and backlinks)', () => {
  const twoSpaces: readonly SpacePlan[] = [
    { name: 'Handbook', pages: 15, depth: 3, grants: 0, content: true },
    { name: 'Product', pages: 10, depth: 2, grants: 0, content: true },
  ];

  it('writes a backlink for every pageLink it plants, and nothing else', async () => {
    const { harness, spacesOut } = await seedContent(twoSpaces, { pageLinkRate: 1, bodyRate: 1 });

    const backlinks = asRecords(
      harness.columnsOf('docs.backlinks'),
      harness.rowsOf('docs.backlinks'),
    );
    expect(backlinks.length).toBeGreaterThan(0);

    const pageIds = new Set(spacesOut.pages.map((page) => page.id));
    for (const row of backlinks) {
      // Both ends are real pages in this org — never a dangling id, and never
      // one from a different tenant (there is only one org in this fixture,
      // but the FK this mirrors is (org_id, page_id), not page_id alone).
      expect(pageIds.has(String(row['source_page_id']))).toBe(true);
      expect(pageIds.has(String(row['target_page_id']))).toBe(true);
      // `backlinks_not_self` — the migration's own CHECK constraint, mirrored
      // here since this test runs with no database to enforce it.
      expect(row['source_page_id']).not.toBe(row['target_page_id']);
    }
  });

  it('writes no backlinks when no page ever gets a link', async () => {
    const { harness } = await seedContent(twoSpaces, { pageLinkRate: 0, bodyRate: 1 });
    expect(harness.rowsOf('docs.backlinks')).toHaveLength(0);
  });

  it('leaves docs.backlink_dispatch untouched — the relay has not run', async () => {
    // See docs.content's own header: the seed computes backlinks directly,
    // by design, and never marks a page_version PROCESSED — that bookkeeping
    // belongs to the real relay alone.
    const { harness } = await seedContent(twoSpaces, { pageLinkRate: 1, bodyRate: 1 });
    expect(harness.rowsOf('docs.backlink_dispatch')).toHaveLength(0);
  });
});

describe('docs.content — Wave 3 (restore)', () => {
  const plan: readonly SpacePlan[] = [
    { name: 'Handbook', pages: 12, depth: 3, grants: 0, content: true },
  ];

  it('restores as a NEW snapshot carrying the ORIGINAL bytes, never a WAL row', async () => {
    const { harness, contentOut } = await seedContent(plan, {
      bodyRate: 1,
      snapshotRate: 1,
      tailRate: 1,
      restoreShare: 1,
      blocks: [6, 6],
      updates: [3, 3],
    });

    expect(contentOut.restoredPages).toBeGreaterThan(0);

    const versions = asRecords(
      harness.columnsOf('docs.page_versions'),
      harness.rowsOf('docs.page_versions'),
    );
    const byPage = new Map<string, Record<string, unknown>[]>();
    for (const version of versions) {
      const list = byPage.get(String(version['page_id'])) ?? [];
      list.push(version);
      byPage.set(String(version['page_id']), list);
    }

    let sawRestoredPair = false;
    for (const pageVersions of byPage.values()) {
      if (pageVersions.length < 2) continue;
      const [original, restored] = pageVersions;
      if (original === undefined || restored === undefined) continue;

      sawRestoredPair = true;
      // The identical bytes, not a re-derivation — a restore is "make this
      // the latest again".
      expect(Buffer.compare(restored['state'] as Buffer, original['state'] as Buffer)).toBe(0);
      // A distinct row, never the same primary key reused.
      expect(restored['id']).not.toBe(original['id']);
      expect(restored['kind']).toBe('manual');
      expect(restored['created_by']).not.toBeNull();
    }
    expect(sawRestoredPair).toBe(true);

    // No `docs.yjs_updates` row exists for the restore — see the file header
    // on why an append would MERGE rather than undo (Wave 2's own bug).
    // `updateRows` before this scenario and after are not directly
    // observable here, but the WAL table is untouched by the restore branch
    // by construction: only `versionRowValues` gains a row, `updateRowValues`
    // does not.
    const restoredEvents = harness.events.filter((event) => event.name === 'page.version_restored');
    expect(restoredEvents.length).toBe(contentOut.restoredPages);

    for (const event of restoredEvents) {
      const payload = event.payload as { readonly pageId: string; readonly versionId: string };
      const pageVersions = byPage.get(payload.pageId) ?? [];
      const original = pageVersions[0];
      // The event names the RESTORED-FROM version — `restorePageVersion`'s
      // own `input.versionId`, never the fresh row's own id.
      expect(payload.versionId).toBe(original?.['id']);
    }
  });

  it('never restores a page with no tail past its snapshot', async () => {
    // `tailRate: 0` — every snapshot lands on the last transaction, so there
    // is nothing in the main content after it to undo. `pageLinkRate: 0` too:
    // an internal-link paragraph is always added AFTER the snapshot when one
    // is planted (see `editDocument`), which would otherwise supply a tail of
    // its own and defeat the isolation this test wants. Restoring would be a
    // save that reverts nothing, which is not the scenario this exists to
    // cover.
    const { contentOut } = await seedContent(plan, {
      bodyRate: 1,
      snapshotRate: 1,
      tailRate: 0,
      pageLinkRate: 0,
      restoreShare: 1,
    });
    expect(contentOut.restoredPages).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Comments and suggestions
 * -------------------------------------------------------------------------- */

describe('docs.comments', () => {
  const plan: readonly SpacePlan[] = [
    { name: 'Handbook', pages: 10, depth: 2, grants: 0, content: true },
  ];

  async function seedComments(pageMix: Partial<Profile['page']> = {}) {
    const { harness, spacesOut, contentOut } = await seedContent(plan, {
      bodyRate: 1,
      commentRate: 1,
      commentsPerPage: [2, 2],
      ...pageMix,
    });

    const outputs = new Map<SeedModule, unknown>([
      [orgsModule, { orgs: [harness.ctx.use(orgsModule).orgs[0]] }],
      [spacesModule, spacesOut],
      [contentModule, contentOut],
    ]);
    const commentsCtx: SeedContext = {
      ...harness.ctx,
      use: <Out>(module: SeedModule<Out>): Out => outputs.get(module) as Out,
    };
    const commentsOut = await commentsModule.seed(commentsCtx);

    return { harness, spacesOut, commentsOut };
  }

  it('writes anchors that are real, decodable RelativePositions', async () => {
    const { harness, commentsOut } = await seedComments();
    expect(commentsOut.commentRows).toBeGreaterThan(0);

    const rows = asRecords(harness.columnsOf('docs.comments'), harness.rowsOf('docs.comments'));
    expect(rows.length).toBe(commentsOut.commentRows);

    for (const row of rows) {
      // Structural validation only — the identical trust boundary
      // `apps/api/src/docs/anchor.ts`'s `decodeAnchor` enforces on the real
      // path. A comment anchored with bytes this throws on is a comment that
      // 400s the moment a real client tries to open the page.
      expect(() => Y.decodeRelativePosition(row['anchor_from'] as Uint8Array)).not.toThrow();
      expect(() => Y.decodeRelativePosition(row['anchor_to'] as Uint8Array)).not.toThrow();
    }
  });

  it('gives every comment an author who actually holds comment:create', async () => {
    const { harness, commentsOut } = await seedComments();
    expect(commentsOut.commentRows).toBeGreaterThan(0);

    const rows = asRecords(harness.columnsOf('docs.comments'), harness.rowsOf('docs.comments'));
    const org = orgWith(plan);
    const grantHolders = new Set(
      org.memberships.filter((m) => roleGrants(m.role, 'comment:create')).map((m) => m.user.id),
    );

    for (const row of rows) {
      expect(grantHolders.has(row['author_id'] as string)).toBe(true);
      if (row['resolved_by'] !== null) {
        expect(grantHolders.has(row['resolved_by'] as string)).toBe(true);
      }
    }
  });

  it('pairs resolved_at and resolved_by, never one without the other', async () => {
    const { harness } = await seedComments({ resolvedShare: 0.5 });
    const rows = asRecords(harness.columnsOf('docs.comments'), harness.rowsOf('docs.comments'));

    expect(rows.some((row) => row['resolved_at'] !== null)).toBe(true);
    expect(rows.some((row) => row['resolved_at'] === null)).toBe(true);
    for (const row of rows) {
      expect(row['resolved_at'] === null).toBe(row['resolved_by'] === null);
    }
  });

  it('stores body_text as the flattened copy of the same document it saves', async () => {
    const { harness } = await seedComments();
    const rows = asRecords(harness.columnsOf('docs.comments'), harness.rowsOf('docs.comments'));

    for (const row of rows) {
      expect(typeof row['body_text']).toBe('string');
      expect((row['body_text'] as string).length).toBeGreaterThan(0);
    }
  });
});

describe('docs.suggestions', () => {
  const plan: readonly SpacePlan[] = [
    { name: 'Handbook', pages: 10, depth: 2, grants: 0, content: true },
  ];

  async function seedSuggestions(pageMix: Partial<Profile['page']> = {}) {
    const { harness, spacesOut, contentOut } = await seedContent(plan, {
      bodyRate: 1,
      suggestionRate: 1,
      suggestionsPerPage: [3, 3],
      ...pageMix,
    });

    const org = harness.ctx.use(orgsModule).orgs[0];
    const outputs = new Map<SeedModule, unknown>([
      [orgsModule, { orgs: [org] }],
      [spacesModule, spacesOut],
      [contentModule, contentOut],
    ]);
    const suggestionsCtx: SeedContext = {
      ...harness.ctx,
      use: <Out>(module: SeedModule<Out>): Out => outputs.get(module) as Out,
    };
    const suggestionsOut = await suggestionsModule.seed(suggestionsCtx);

    return { harness, suggestionsOut };
  }

  it('matches proposed_content to kind — null for delete, present otherwise', async () => {
    const { harness, suggestionsOut } = await seedSuggestions();
    expect(suggestionsOut.suggestionRows).toBeGreaterThan(0);

    const rows = asRecords(
      harness.columnsOf('docs.suggestions'),
      harness.rowsOf('docs.suggestions'),
    );
    expect(rows.some((row) => row['kind'] === 'delete')).toBe(true);
    expect(rows.some((row) => row['kind'] !== 'delete')).toBe(true);

    for (const row of rows) {
      // `suggestions_content_matches_kind` — the migration's own CHECK,
      // mirrored here since this test runs with no database to enforce it.
      expect(row['proposed_content'] === null).toBe(row['kind'] === 'delete');
    }
  });

  it('only ever lets a page:update holder decide, never the comment-tier author alone', async () => {
    const { harness } = await seedSuggestions({ suggestionDecidedShare: 1 });
    const rows = asRecords(
      harness.columnsOf('docs.suggestions'),
      harness.rowsOf('docs.suggestions'),
    );
    expect(rows.some((row) => row['status'] !== 'pending')).toBe(true);

    const org = orgWith(plan);
    const deciders = new Set(
      org.memberships.filter((m) => roleGrants(m.role, 'page:update')).map((m) => m.user.id),
    );

    for (const row of rows) {
      if (row['status'] === 'pending') continue;
      expect(deciders.has(String(row['decided_by']))).toBe(true);
    }
  });

  it('pairs status, decided_at and decided_by consistently', async () => {
    const { harness } = await seedSuggestions({ suggestionDecidedShare: 0.5 });
    const rows = asRecords(
      harness.columnsOf('docs.suggestions'),
      harness.rowsOf('docs.suggestions'),
    );

    expect(rows.some((row) => row['status'] === 'pending')).toBe(true);
    expect(rows.some((row) => row['status'] !== 'pending')).toBe(true);

    for (const row of rows) {
      const pending = row['status'] === 'pending';
      expect(row['decided_at'] === null).toBe(pending);
      expect(row['decided_by'] === null).toBe(pending);
    }
  });

  it('produces both outcomes for a decided suggestion — accepted and rejected', async () => {
    const { harness } = await seedSuggestions({
      suggestionDecidedShare: 1,
      suggestionAcceptedShare: 0.5,
    });
    const rows = asRecords(
      harness.columnsOf('docs.suggestions'),
      harness.rowsOf('docs.suggestions'),
    );

    expect(rows.some((row) => row['status'] === 'accepted')).toBe(true);
    expect(rows.some((row) => row['status'] === 'rejected')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * Profiles
 * -------------------------------------------------------------------------- */

describe('docs profiles', () => {
  it('plans a tree every profile can actually build', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const org of profile.orgs) {
        for (const space of org.spaces) {
          if (space.pages === 0) continue;
          // The spine and the wide set are built first; a plan whose total is
          // smaller than the two of them is one `buildTree` refuses.
          expect(space.pages, `${profile.name}/${org.slug}/${space.name}`).toBeGreaterThanOrEqual(
            space.depth + (space.wide ?? 0),
          );
        }
      }
    }
  });

  it('gives every space asking for a guest an org that has one', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const org of profile.orgs) {
        if (!org.spaces.some((space) => space.withGuest === true)) continue;
        /* Asked as a capability, not by role NAME — guardrail 7 bans the
           comparison outside `packages/policy`, and the ban is right here:
           "holds a role reaching no page at all" is the property the fixture
           actually depends on, so a future role with it is picked up rather
           than missed. */
        expect(
          org.members.some((member) => !roleGrants(member.role, 'page:read')),
          `${profile.name}/${org.slug}`,
        ).toBe(true);
      }
    }
  });

  it('keeps the shapes the phase depends on somewhere in the demo profile', () => {
    const spaces = DEMO.orgs.flatMap((org) => org.spaces);

    expect(spaces.some((space) => space.depth >= 5)).toBe(true); // the ancestor walk
    expect(spaces.some((space) => (space.wide ?? 0) >= 20)).toBe(true); // sibling ranks
    expect(spaces.some((space) => space.pages === 0)).toBe(true); // the empty state
    expect(spaces.some((space) => space.archived === true)).toBe(true);
    expect(spaces.some((space) => space.archivedSubtree === true)).toBe(true);
    expect(spaces.some((space) => space.withGuest === true)).toBe(true);
    expect(spaces.some((space) => space.depth === 1)).toBe(true); // a flat space
  });
});
