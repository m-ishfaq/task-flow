import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type ProjectId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from '../work/project.service.js';
import { isSubscribed, subscribe, unsubscribe } from './subscription.service.js';
import { standupSubscriptionCreated, standupSubscriptionRemoved } from './events.js';
import type { WorkActor } from '../work/shared.js';

/**
 * "Email me this project's standup" (migration 0108) — the property only a
 * real Postgres connection proves is `standup_subscriptions_unique` making
 * a repeated subscribe idempotent on the ROW while `subscribe` still emits
 * its own event every call (a person clicking the toggle twice is a real
 * attempt worth recording), and the `project:read` floor actually refusing
 * a caller with no access.
 */

const OWNER = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-000000000301');
const OUTSIDER = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-000000000302');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@standup-sub.test'],
  [OUTSIDER, 'outsider@standup-sub.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195f400-0000-7000-8000-0000000003ff');

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
  // Children before parents.
  await admin.query(`DELETE FROM platform.standup_subscriptions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
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

async function scaffold(
  slug: string,
): Promise<{ orgId: OrgId; owner: WorkActor; projectId: ProjectId }> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');
  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  return { orgId, owner, projectId: project.projectId };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-standup-sub-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
});

describe('subscribe', () => {
  it('creates a subscription and emits standup_subscription.created', async () => {
    const fixture = await scaffold('standup-sub-create');

    const result = await subscribe(fixture.owner, { projectId: fixture.projectId });
    expect(result).toEqual({ subscribed: true });

    const status = await isSubscribed(fixture.owner, { projectId: fixture.projectId });
    expect(status).toEqual({ subscribed: true });

    const events = await outboxFor(fixture.orgId);
    const created = events.filter((event) => event.name === standupSubscriptionCreated.name);
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ projectId: fixture.projectId, userId: OWNER });
  });

  it('is idempotent on the row — subscribing twice writes one row, two events', async () => {
    const fixture = await scaffold('standup-sub-idempotent');

    await subscribe(fixture.owner, { projectId: fixture.projectId });
    await subscribe(fixture.owner, { projectId: fixture.projectId });

    await admin.setOrg(fixture.orgId);
    const rows = await admin.query(
      `SELECT id FROM platform.standup_subscriptions WHERE org_id = $1 AND project_id = $2 AND user_id = $3`,
      [fixture.orgId, fixture.projectId, OWNER],
    );
    await admin.setOrg(null);
    expect(rows.rows).toHaveLength(1);

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === standupSubscriptionCreated.name)).toHaveLength(
      2,
    );
  });

  it('refuses a caller who cannot read the project', async () => {
    const fixture = await scaffold('standup-sub-refuse');
    const outsider = await actorFor(fixture.orgId, OUTSIDER, 'guest');

    await expect(subscribe(outsider, { projectId: fixture.projectId })).rejects.toBeDefined();

    const status = await isSubscribed(fixture.owner, { projectId: fixture.projectId });
    expect(status).toEqual({ subscribed: false });
  });
});

describe('unsubscribe', () => {
  it('removes the subscription and emits standup_subscription.removed', async () => {
    const fixture = await scaffold('standup-sub-remove');
    await subscribe(fixture.owner, { projectId: fixture.projectId });

    const result = await unsubscribe(fixture.owner, { projectId: fixture.projectId });
    expect(result).toEqual({ unsubscribed: true });

    const status = await isSubscribed(fixture.owner, { projectId: fixture.projectId });
    expect(status).toEqual({ subscribed: false });

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === standupSubscriptionRemoved.name)).toHaveLength(
      1,
    );
  });

  it('unsubscribing when never subscribed is a no-op — no event', async () => {
    const fixture = await scaffold('standup-sub-noop');

    const result = await unsubscribe(fixture.owner, { projectId: fixture.projectId });
    expect(result).toEqual({ unsubscribed: false });

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === standupSubscriptionRemoved.name)).toHaveLength(
      0,
    );
  });
});
