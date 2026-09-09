import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type CardId, type ListId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import { isCalendarSynced, toggleCalendarSync } from './card-calendar.service.js';
import { cardCalendarSyncToggled } from './events.js';
import type { WorkActor } from './shared.js';

/**
 * Per-card calendar sync (migration 0110) — opt-in per event, chosen
 * explicitly over a default "assigned to me" scope. The properties only a
 * real Postgres connection proves: the unique index makes toggling on twice
 * idempotent rather than a second row, and this is self-referential ONLY —
 * `toggleCalendarSync` never takes a `userId` field, so there is no way to
 * write this test to opt someone else in even by accident.
 */

const OWNER = unsafeAsId<'UserId'>('0195ef20-0000-7000-8000-000000000101');
const MEMBER = unsafeAsId<'UserId'>('0195ef20-0000-7000-8000-000000000102');
const GUEST = unsafeAsId<'UserId'>('0195ef20-0000-7000-8000-000000000103');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@card-calendar.test'],
  [MEMBER, 'member@card-calendar.test'],
  [GUEST, 'guest@card-calendar.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ef20-0000-7000-8000-0000000001ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<WorkActor> {
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
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.card_calendar_subscriptions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.views WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function outboxFor(
  orgId: OrgId,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  await admin.setOrg(orgId);
  const rows = await admin.query(
    `SELECT name, payload FROM platform.outbox WHERE org_id = $1 ORDER BY created_at`,
    [orgId],
  );
  await admin.setOrg(null);
  return rows.rows.map((row) => ({
    name: String(row['name']),
    payload: (row['payload'] ?? {}) as Record<string, unknown>,
  }));
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly listId: ListId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');

  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(owner, { projectId: project.projectId, name: 'Delivery' });
  const list = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });

  return { orgId, owner, listId: list.listId };
}

async function makeCard(owner: WorkActor, fixture: Fixture): Promise<{ cardId: CardId }> {
  const card = await cards.createCard(owner, {
    listId: fixture.listId,
    title: 'Fix login bug',
    description: null,
  });
  return { cardId: card.cardId };
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
    applicationName: 'taskflow-card-calendar-svc-test',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
});

describe('toggleCalendarSync', () => {
  it('syncs a card and reports it as synced', async () => {
    const fixture = await scaffold('sync-on');
    const card = await makeCard(fixture.owner, fixture);

    const result = await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });
    expect(result).toEqual({ synced: true });
    expect(await isCalendarSynced(fixture.owner, { cardId: card.cardId })).toBe(true);
  });

  it('is idempotent — syncing twice writes one row, two events', async () => {
    const fixture = await scaffold('sync-idempotent');
    const card = await makeCard(fixture.owner, fixture);

    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });
    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });

    await admin.setOrg(fixture.orgId);
    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM platform.card_calendar_subscriptions WHERE card_id = $1`,
      [card.cardId],
    );
    await admin.setOrg(null);
    expect(rows.rows[0]?.['n']).toBe(1);

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardCalendarSyncToggled.name)).toHaveLength(2);
  });

  it('unsyncs a card, idempotently', async () => {
    const fixture = await scaffold('sync-off');
    const card = await makeCard(fixture.owner, fixture);

    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });
    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: false });
    // A second "off" is a no-op, not an error.
    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: false });

    expect(await isCalendarSynced(fixture.owner, { cardId: card.cardId })).toBe(false);
  });

  it('is per-viewer — one person syncing a card does not sync it for another', async () => {
    const fixture = await scaffold('sync-per-viewer');
    const card = await makeCard(fixture.owner, fixture);
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });

    expect(await isCalendarSynced(fixture.owner, { cardId: card.cardId })).toBe(true);
    expect(await isCalendarSynced(member, { cardId: card.cardId })).toBe(false);
  });

  it('refuses a guest with no card:read on this project', async () => {
    const fixture = await scaffold('sync-refuse');
    const card = await makeCard(fixture.owner, fixture);
    const guest = await actorFor(fixture.orgId, GUEST, 'guest');

    await expect(
      toggleCalendarSync(guest, { cardId: card.cardId, synced: true }),
    ).rejects.toThrow();
  });
});
