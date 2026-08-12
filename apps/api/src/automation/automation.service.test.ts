import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { compare } from '@taskflow/filter';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  setAutomationEnabled,
  updateAutomation,
  type AutomationActor,
  type AutomationInput,
} from './automation.service.js';

/**
 * Automation rule management (ai/phase-10-automation.md §1, §2).
 *
 * The ENGINE's behaviour is tested in `apps/worker`. What is under test here is
 * what may be WRITTEN, and the three refusals that exist because a rule
 * accepted now and silently broken forever is much worse than one rejected
 * while its author is still looking at it.
 *
 * The most important assertion in this file is the ownership one: an edit must
 * not be able to re-point a rule at the editor's own permissions.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee30-0000-7000-8000-000000000001');
const ADMIN = unsafeAsId<'UserId'>('0195ee30-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@automation-service.test'],
  [ADMIN, 'admin@automation-service.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee30-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];
let fixtureCounter = 0;

async function actorFor(
  orgId: OrgId,
  userId: UserId,
  role: AutomationActor['subject']['role'],
): Promise<AutomationActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

function ruleBody(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    name: `Rule ${String(fixtureCounter)}-${crypto.randomUUID().slice(0, 6)}`,
    description: null,
    triggerEvent: 'card.status_changed',
    condition: null,
    actions: [{ type: 'chat.post_message', channelId: crypto.randomUUID(), body: 'shipped' }],
    enabled: true,
    ...overrides,
  };
}

async function scaffold(slug: string): Promise<{
  orgId: OrgId;
  owner: AutomationActor;
  adminActor: AutomationActor;
}> {
  fixtureCounter += 1;
  const uniqueSlug = `as-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Auto ${slug}`, slug: uniqueSlug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  await members.addMember(
    result.orgId,
    { email: 'admin@automation-service.test', role: 'admin' },
    { userId: OWNER, requestId },
  );

  return {
    orgId: result.orgId,
    owner: await actorFor(result.orgId, OWNER, 'owner'),
    adminActor: await actorFor(result.orgId, ADMIN, 'admin'),
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
    'platform.automation_runs',
    'platform.automation_budget',
    'platform.automations',
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-automation-svc' });
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

describe('creating a rule — what is refused at save time', () => {
  it('accepts an ordinary cross-product rule', async () => {
    const { owner } = await scaffold('ok');
    await expect(createAutomation(owner, ruleBody())).resolves.toMatchObject({
      automationId: expect.any(String) as unknown as string,
    });
  });

  it('refuses a trigger no build registers', async () => {
    const { owner } = await scaffold('trigger');

    /* Checked against the LIVE registry, not a CHECK constraint. A constraint
       would be a second copy of the event catalog that drifts every time a
       slice adds an event, and the drift's failure mode is a rule that saves
       cleanly and never fires — silent, and indistinguishable from a condition
       that never matches. */
    await expect(
      createAutomation(owner, ruleBody({ triggerEvent: 'card.teleported' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a condition naming a field cards do not have', async () => {
    const { owner } = await scaffold('condition');

    /* `author` is a SEARCH field; cards have `creator`. Wave 1 evaluates
       conditions against the card row, so this would store fine and then be
       refused at every single execution with `condition_unusable`. */
    await expect(
      createAutomation(owner, ruleBody({ condition: compare('author', 'eq', '@me') })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  /* §7.8b — the field set a condition is read against comes from the TRIGGER,
     and the card and connector sets do not overlap. Both directions are tested
     because getting this wrong in either one is silent: a connector rule
     validated as `card` is refused at save with a confusing message, and a card
     rule validated as `connector` would be accepted and then refused forever at
     execution. */
  it('refuses a CARD field on a connector trigger', async () => {
    const { owner } = await scaffold('conncard');

    await expect(
      createAutomation(
        owner,
        ruleBody({
          triggerEvent: 'integration.github_event',
          condition: compare('priority', 'eq', 'high'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a CONNECTOR field on a card trigger', async () => {
    const { owner } = await scaffold('cardconn');

    await expect(
      createAutomation(
        owner,
        ruleBody({
          triggerEvent: 'card.status_changed',
          condition: compare('provider_event', 'eq', 'push'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('accepts a connector condition and reads it back unbroken', async () => {
    const { owner } = await scaffold('connok');

    await createAutomation(
      owner,
      ruleBody({
        triggerEvent: 'integration.github_event',
        condition: compare('provider_event', 'in', ['push', 'pull_request']),
      }),
    );

    /* `conditionBroken` is the assertion that matters. The list projection
       re-validates every stored condition, and doing that against the card set
       would report a perfectly good connector rule as broken — which the UI
       shows as a warning and an author would "fix" by deleting it. */
    const rule = (await listAutomations(owner)).find(
      (entry) => entry.triggerEvent === 'integration.github_event',
    );
    expect(rule?.conditionBroken).toBe(false);
    expect(JSON.stringify(rule?.condition)).toContain('provider_event');
  });

  it('refuses a rule whose own action re-triggers it', async () => {
    const { owner } = await scaffold('selftrigger');

    /* The engine refuses this too, so this is not the control — it is the
       difference between being told now and finding five `depth_exceeded` runs
       in the history later and having to work out why. */
    await expect(
      createAutomation(
        owner,
        ruleBody({
          triggerEvent: 'card.updated',
          actions: [{ type: 'card.set_priority', priority: 'high' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('accepts every action in the catalog, including the removers and add-comment', async () => {
    const { owner } = await scaffold('actions');

    /* The three newest actions are full-replace subtractors or writers: they
       must save exactly like the originals. Their EXECUTION is covered by the
       worker's engine suite against real Postgres; what is under test here is
       the write boundary accepting them. */
    await expect(
      createAutomation(
        owner,
        ruleBody({
          triggerEvent: 'card.created',
          actions: [
            { type: 'card.add_comment', body: 'moved by automation' },
            { type: 'card.remove_label', labelId: crypto.randomUUID() },
            { type: 'card.unassign', userId: OWNER },
          ],
        }),
      ),
    ).resolves.toMatchObject({ automationId: expect.any(String) as unknown as string });
  });

  it('refuses a comment-triggered rule whose action adds a comment', async () => {
    const { owner } = await scaffold('commentloop');

    /* `card.add_comment` emits `comment.created` — the rule's own trigger.
       The save-time self-trigger check must see it even though this is a NEW
       action, which is exactly the check the exhaustive loop-protection table
       exists to feed. */
    await expect(
      createAutomation(
        owner,
        ruleBody({
          triggerEvent: 'comment.created',
          actions: [{ type: 'card.add_comment', body: 'echo' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('accepts a valid card condition and reads it back intact', async () => {
    const { owner } = await scaffold('roundtrip');
    await createAutomation(owner, ruleBody({ condition: compare('priority', 'eq', 'high') }));

    const [rule] = await listAutomations(owner);
    expect(rule?.conditionBroken).toBe(false);
    expect(JSON.stringify(rule?.condition)).toContain('priority');
  });

  it('refuses a second rule with the same name', async () => {
    const { owner } = await scaffold('dupe');
    const body = ruleBody({ name: 'Notify on done' });

    await createAutomation(owner, body);
    await expect(createAutomation(owner, body)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('editing a rule — ownership is not editable', () => {
  it('keeps the ORIGINAL author as the rule owner when someone else edits it', async () => {
    const { owner, adminActor } = await scaffold('ownership');
    const { automationId } = await createAutomation(owner, ruleBody());

    await updateAutomation(adminActor, {
      ...ruleBody({ name: 'Renamed by the admin' }),
      automationId,
    });

    /* THE assertion in this file. `createdBy` is whose permissions the rule
       ACTS WITH, re-resolved at execution by the worker. If an edit moved it,
       "rename this rule" would quietly become "re-point this rule at my own,
       possibly higher, privileges" — a privilege escalation wearing the shape
       of a rename, performed by someone who may legitimately edit the rule. */
    const [rule] = await listAutomations(owner);
    expect(rule?.name).toBe('Renamed by the admin');
    expect(rule?.createdBy).toBe(OWNER);
  });

  it('re-runs every save-time refusal on update, not just on create', async () => {
    const { owner } = await scaffold('updatechecks');
    const { automationId } = await createAutomation(owner, ruleBody());

    /* A rule can be made self-triggering by EDITING it, and a check that only
       ran on create would let exactly that through — the shape of most
       validation holes. */
    await expect(
      updateAutomation(owner, {
        ...ruleBody({
          triggerEvent: 'card.updated',
          actions: [{ type: 'card.set_priority', priority: 'low' }],
        }),
        automationId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('the kill switch', () => {
  it('disables a rule without requiring a valid rule body', async () => {
    const { owner } = await scaffold('killswitch');
    const { automationId } = await createAutomation(owner, ruleBody());

    /* Its own route for exactly this reason: stopping a misbehaving rule is
       done in a hurry, and making it require a complete valid body would run
       the emergency path through the same validation that might refuse the
       rule someone is trying to stop. */
    await expect(setAutomationEnabled(owner, { automationId, enabled: false })).resolves.toEqual({
      enabled: false,
    });

    const [rule] = await listAutomations(owner);
    expect(rule?.enabled).toBe(false);
  });

  it('refuses to touch a rule that does not exist', async () => {
    const { owner } = await scaffold('missing');
    await expect(
      setAutomationEnabled(owner, { automationId: crypto.randomUUID(), enabled: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('deleting a rule', () => {
  it('removes it and leaves the org’s other rules alone', async () => {
    const { owner } = await scaffold('delete');
    const first = await createAutomation(owner, ruleBody({ name: 'First' }));
    await createAutomation(owner, ruleBody({ name: 'Second' }));

    await deleteAutomation(owner, { automationId: first.automationId });

    const remaining = await listAutomations(owner);
    expect(remaining.map((rule) => rule.name)).toEqual(['Second']);
  });
});
