import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  updateSavedSearch,
  type SavedSearchActor,
} from './saved-search.service.js';

/**
 * Saved searches (ai/phase-8-search.md §3.2, migration 0046), against real
 * Postgres.
 *
 * Three properties carry this file, and each is a decision the service could
 * plausibly have made the other way:
 *
 *   1. A PRIVATE saved search is author-only with NO permission override — an
 *      owner cannot edit or even see another person's bookmark. The natural
 *      implementation (floor on `search:query`, load by id, write) grants
 *      every member edit rights over everyone's private entries and looks
 *      completely reasonable in a diff.
 *   2. SHARING is a second, role-only question. `search:query` is not an
 *      org-level permission, so a relationship tuple can satisfy the route's
 *      floor — the role-only `search:manage` call is the layer that refuses a
 *      member regardless.
 *   3. The stored query stays UNRESOLVED. A shared "assigned to me" search
 *      that resolved `@me` at save time would mean "assigned to whoever saved
 *      it" for every colleague who ran it.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000002');
const OTHER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@saved.test'],
  [MEMBER, 'member@saved.test'],
  [OTHER, 'other@saved.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee20-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];
let fixtureCounter = 0;

async function actorFor(
  orgId: OrgId,
  userId: UserId,
  role: SavedSearchActor['subject']['role'],
): Promise<SavedSearchActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function scaffold(slug: string): Promise<{
  orgId: OrgId;
  owner: SavedSearchActor;
  member: SavedSearchActor;
  other: SavedSearchActor;
}> {
  fixtureCounter += 1;
  const uniqueSlug = `ss-${fixtureCounter.toString(36)}-${slug.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Saved ${slug}`, slug: uniqueSlug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  for (const email of ['member@saved.test', 'other@saved.test']) {
    await members.addMember(result.orgId, { email, role: 'member' }, { userId: OWNER, requestId });
  }

  return {
    orgId: result.orgId,
    owner: await actorFor(result.orgId, OWNER, 'owner'),
    member: await actorFor(result.orgId, MEMBER, 'member'),
    other: await actorFor(result.orgId, OTHER, 'member'),
  };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'search.searches',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-saved-search-test' });
});

afterAll(async () => {
  await closeDatabase();
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('saved searches — the two-tier permission split', () => {
  it('lets a member keep a private search and refuses them a shared one', async () => {
    const { member } = await scaffold('tiers');

    await expect(
      createSavedSearch(member, { name: 'Mine', query: 'author = me', isShared: false }),
    ).resolves.toMatchObject({ searchId: expect.any(String) as unknown as string });

    /* The refusal is FORBIDDEN, not NOT_FOUND: the caller can see the concept,
       they simply may not share. `enforce()` would have answered NOT_FOUND
       here (there is no `search:read` for its denial helper to consult), which
       describes nothing that happened. */
    await expect(
      createSavedSearch(member, { name: 'Everyone', query: 'type = card', isShared: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets an owner share one, and every member then sees it', async () => {
    const { owner, member } = await scaffold('shared');

    await createSavedSearch(owner, { name: 'Open bugs', query: 'type = card', isShared: true });
    await createSavedSearch(member, { name: 'Mine', query: 'author = me', isShared: false });

    const seenByMember = await listSavedSearches(member);
    expect(seenByMember.map((row) => row.name).sort()).toEqual(['Mine', 'Open bugs']);
  });

  it('never shows one member the private search of another', async () => {
    const { member, other } = await scaffold('private');

    const mine = await createSavedSearch(member, {
      name: 'Secret',
      query: 'text contains resignation',
      isShared: false,
    });

    expect((await listSavedSearches(other)).map((row) => row.name)).toEqual([]);

    /* NOT_FOUND, not FORBIDDEN — another person's private bookmark is one the
       caller should not learn the existence of (§8.7). */
    await expect(
      updateSavedSearch(other, {
        searchId: mine.searchId,
        name: 'Stolen',
        query: 'type = card',
        isShared: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(deleteSavedSearch(other, { searchId: mine.searchId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('does not let even an OWNER edit a member’s private search', async () => {
    const { owner, member } = await scaffold('nooverride');

    const mine = await createSavedSearch(member, {
      name: 'Mine',
      query: 'author = me',
      isShared: false,
    });

    /* The whole point of the "author-only, no permission override" rule: a
       personal bookmark an administrator can silently rewrite is not personal
       (CLAUDE.md's own argument about comment editing). */
    await expect(
      updateSavedSearch(owner, {
        searchId: mine.searchId,
        name: 'Rewritten',
        query: 'type = page',
        isShared: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('treats un-sharing as the same administrative act as sharing', async () => {
    const { owner, member } = await scaffold('unshare');

    const shared = await createSavedSearch(owner, {
      name: 'Team view',
      query: 'type = card',
      isShared: true,
    });

    /* A member can SEE it (it is shared) and must not be able to remove it
       from everyone else by flipping the flag. The check is on the CHANGE, so
       both directions need `search:manage`. */
    await expect(
      updateSavedSearch(member, {
        searchId: shared.searchId,
        name: 'Team view',
        query: 'type = card',
        isShared: false,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('saved searches — the stored query', () => {
  it('stores the TQL verbatim, with @me and relative dates unresolved', async () => {
    const { owner } = await scaffold('symbolic');

    const query = 'author = me AND updated > -7d';
    await createSavedSearch(owner, { name: 'My week', query, isShared: false });

    const [row] = await listSavedSearches(owner);
    /* Character-for-character. A tree stored and re-formatted would come back
       normalized — the author's own words, reworded by the system — and a
       tree stored RESOLVED would come back naming a user id and a date, which
       is the bug that makes a shared "assigned to me" mean the wrong person. */
    expect(row?.query).toBe(query);
    expect(row?.broken).toBe(false);
  });

  it('refuses an invalid query at the WRITE, not on the next read', async () => {
    const { owner } = await scaffold('invalid');

    /* `assignee` is a CARD field and is NOT in the cross-product search field
       set — a query that parses perfectly and means nothing here. This is the
       case a shape-only check would wave through, and the reason the service
       runs `validate('search', …)` and not just `parse`. Failing now is the
       honest moment: the author is still looking at what they typed.
       (Caught by this suite's own first run, which used `assignee` throughout
       on the assumption the two field sets overlap. They do not.) */
    await expect(
      createSavedSearch(owner, { name: 'Nope', query: 'assignee = me', isShared: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createSavedSearch(owner, { name: 'Nope', query: 'type = (', isShared: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('reports a query that stopped validating as BROKEN, never as a 500', async () => {
    const { orgId, owner } = await scaffold('broken');

    const saved = await createSavedSearch(owner, {
      name: 'Legacy',
      query: 'type = card',
      isShared: false,
    });

    /* Written straight past the service, the way an older build or a hand
       edit would leave it. The CHECK constraints still hold (non-empty, under
       1,000 chars) — this is a string the DATABASE accepts and the PARSER
       does not, which is exactly the state a column-is-not-a-parser argument
       is about. */
    await admin.setOrg(orgId);
    await admin.query(`UPDATE search.searches SET query = $1 WHERE id = $2`, [
      'nosuchfield = 3',
      saved.searchId,
    ]);
    await admin.setOrg(null);

    const rows = await listSavedSearches(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.broken).toBe(true);
  });
});

describe('saved searches — naming', () => {
  it('lets two people each keep a private search of the same name', async () => {
    const { member, other } = await scaffold('samename');

    await createSavedSearch(member, { name: 'Mine', query: 'type = card', isShared: false });
    /* The private unique index is per (org, author, name) — two people each
       keeping a "Mine" is the ordinary case, not a collision. */
    await expect(
      createSavedSearch(other, { name: 'Mine', query: 'type = page', isShared: false }),
    ).resolves.toBeDefined();
  });

  it('refuses a second SHARED search of the same name', async () => {
    const { owner } = await scaffold('dupshared');

    await createSavedSearch(owner, { name: 'Open bugs', query: 'type = card', isShared: true });
    /* Case-insensitive, per the index's `lower(name)`: two shared entries a
       reader cannot tell apart are worse than a refusal. */
    await expect(
      createSavedSearch(owner, { name: 'OPEN BUGS', query: 'type = page', isShared: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
