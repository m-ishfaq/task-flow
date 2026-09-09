import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type ListId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import { toggleCalendarSync } from './card-calendar.service.js';
import { buildCalendarFeed } from './calendar-feed.service.js';
import type { WorkActor } from './shared.js';

/**
 * Assembling one person's calendar feed across every org they belong to
 * (migration 0110) — the properties only real Postgres proves: `card:read`
 * is re-checked per row rather than trusted from the opt-in alone, a card
 * with no due date is excluded even when synced, and a subscription is
 * per-VIEWER, never leaking into another person's feed even for a card
 * both could otherwise read.
 */

const OWNER = unsafeAsId<'UserId'>('0195ef30-0000-7000-8000-000000000101');
const GUEST = unsafeAsId<'UserId'>('0195ef30-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@calendar-feed.test'],
  [GUEST, 'guest@calendar-feed.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ef30-0000-7000-8000-0000000001ff');

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
    applicationName: 'taskflow-calendar-feed-svc-test',
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

describe('buildCalendarFeed', () => {
  it('includes a synced, due-dated card', async () => {
    const fixture = await scaffold('feed-basic');
    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Ship the release',
      description: null,
    });
    await cards.updateCard(fixture.owner, {
      cardId: card.cardId,
      title: 'Ship the release',
      description: null,
      dueDate: new Date('2026-04-01'),
      startDate: null,
      priority: null,
      version: 1,
    });
    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });

    const feed = await buildCalendarFeed(OWNER, TEST_ENV.WEB_ORIGIN);
    const found = feed.find((entry) => entry.cardId === card.cardId);
    expect(found).toBeDefined();
    expect(found?.reference).toBe('WEB-1');
    expect(found?.dueDate).toBe('2026-04-01');
  });

  it('excludes a synced card with no due date', async () => {
    const fixture = await scaffold('feed-no-due-date');
    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'No deadline yet',
      description: null,
    });
    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });

    const feed = await buildCalendarFeed(OWNER, TEST_ENV.WEB_ORIGIN);
    expect(feed.find((entry) => entry.cardId === card.cardId)).toBeUndefined();
  });

  it('excludes a card the caller never opted into', async () => {
    const fixture = await scaffold('feed-not-synced');
    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Untouched',
      description: null,
    });
    await cards.updateCard(fixture.owner, {
      cardId: card.cardId,
      title: 'Untouched',
      description: null,
      dueDate: new Date('2026-04-01'),
      startDate: null,
      priority: null,
      version: 1,
    });

    const feed = await buildCalendarFeed(OWNER, TEST_ENV.WEB_ORIGIN);
    expect(feed.find((entry) => entry.cardId === card.cardId)).toBeUndefined();
  });

  it('is per-viewer — a subscription made by one person never appears in another’s feed', async () => {
    const fixture = await scaffold('feed-per-viewer');
    await members.addMember(
      fixture.orgId,
      { email: 'guest@calendar-feed.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Owner-only',
      description: null,
    });
    await cards.updateCard(fixture.owner, {
      cardId: card.cardId,
      title: 'Owner-only',
      description: null,
      dueDate: new Date('2026-04-01'),
      startDate: null,
      priority: null,
      version: 1,
    });
    await toggleCalendarSync(fixture.owner, { cardId: card.cardId, synced: true });

    const guestFeed = await buildCalendarFeed(GUEST, TEST_ENV.WEB_ORIGIN);
    expect(guestFeed.find((entry) => entry.cardId === card.cardId)).toBeUndefined();
  });

  it('re-checks card:read — a Guest with no tuple on the project sees nothing, even opted in', async () => {
    const fixture = await scaffold('feed-reread-check');
    await members.addMember(
      fixture.orgId,
      { email: 'guest@calendar-feed.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Guarded card',
      description: null,
    });
    await cards.updateCard(fixture.owner, {
      cardId: card.cardId,
      title: 'Guarded card',
      description: null,
      dueDate: new Date('2026-04-01'),
      startDate: null,
      priority: null,
      version: 1,
    });
    // Owner opts the card in on the GUEST's behalf is impossible by design
    // (toggleCalendarSync is self-only) — so simulate the shape this guards
    // against directly: a subscription row exists for a user who currently
    // has no card:read on this project's cards.
    await admin.setOrg(fixture.orgId);
    await admin.query(
      `INSERT INTO platform.card_calendar_subscriptions (id, org_id, card_id, user_id)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [fixture.orgId, card.cardId, GUEST],
    );
    await admin.setOrg(null);

    const guestFeed = await buildCalendarFeed(GUEST, TEST_ENV.WEB_ORIGIN);
    expect(guestFeed.find((entry) => entry.cardId === card.cardId)).toBeUndefined();
  });
});
