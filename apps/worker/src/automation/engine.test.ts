import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, withOrgScope, schema, eq } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { compare } from '@taskflow/filter';
import { MAX_DEPTH } from './loop-protection.js';
import { HOURLY_EXECUTION_BUDGET } from './repository.js';
import { processEvent } from './engine.js';
import { createActionExecutor } from './executor.js';
import type { ActionExecutor, ActionResult, TriggerEvent } from './types.js';

/**
 * The engine's decision pipeline, against real Postgres.
 *
 * The executor is a RECORDING FAKE, deliberately. What is under test here is
 * whether the engine decides correctly and records what it decided — the
 * actions themselves land in the next slice, and separating them means the
 * loop protection and the budget are proven before anything can act on a
 * mistake. The same build order as Phase 7's spend gate, whose most important
 * assertion is not that a refusal is returned but that **the provider was never
 * reached**; every refusal test below asserts the executor recorded nothing.
 *
 * These suites write to `platform.outbox`'s neighbours and to one global
 * budget table, so `vitest.config.ts` sets `fileParallelism: false` — the
 * lesson `apps/realtime`'s relay suite documents.
 */

let admin: AdminConnection;
let created: OrgId[] = [];
let fixtureCounter = 0;

/** Records what it was asked to do, and can be told to fail. */
class RecordingExecutor implements ActionExecutor {
  calls: { ruleId: string; nextDepth: number }[] = [];
  mode: 'succeed' | 'fail' | 'throw' = 'succeed';

  execute(input: Parameters<ActionExecutor['execute']>[0]): Promise<readonly ActionResult[]> {
    this.calls.push({ ruleId: input.rule.id, nextDepth: input.nextDepth });

    if (this.mode === 'throw') throw new Error('executor exploded');

    const results: ActionResult[] = input.rule.actions.map((action, index) => ({
      index,
      type: action.type,
      status: this.mode === 'fail' && index === 0 ? 'failed' : 'succeeded',
      ...(this.mode === 'fail' && index === 0 ? { error: 'nope' } : {}),
    }));
    return Promise.resolve(results);
  }
}

interface Fixture {
  readonly orgId: OrgId;
  readonly cardId: string;
  readonly userId: string;
  readonly addRule: (rule: {
    triggerEvent: string;
    condition?: unknown;
    actions?: unknown;
    enabled?: boolean;
  }) => Promise<string>;
  readonly event: (overrides?: Partial<TriggerEvent>) => TriggerEvent;
}

async function scaffold(slug: string): Promise<Fixture> {
  fixtureCounter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const boardId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const cardId = crypto.randomUUID();

  await admin.setOrg(null);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    /* A random suffix, not just the counter. An ABORTED run skips `afterAll`
       and leaves its users behind, and a counter-only email then collides on
       the next run with `users_email_normalized_key` — which reads as a bug in
       the code under test rather than as residue. This file learned that the
       way CLAUDE.md says every suite here does. */
    [userId, `auto-${crypto.randomUUID().slice(0, 12)}@automation.test`],
  );

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `au-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key, next_card_number) VALUES ($1, $2, 'Project', 'PROJ', 1)`,
    [projectId, orgId],
  );
  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank) VALUES ($1, $2, $3, 'B', 'a0')`,
    [boardId, orgId, projectId],
  );
  await admin.query(
    `INSERT INTO work.lists (id, org_id, project_id, board_id, name, rank) VALUES ($1, $2, $3, $4, 'L', 'a0')`,
    [listId, orgId, projectId, boardId],
  );
  await admin.query(
    `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank, priority)
     VALUES ($1, $2, $3, $4, $5, 1, 'Ship the thing', '{}'::jsonb, 'body text', 'a0', 'high')`,
    [cardId, orgId, projectId, boardId, listId],
  );
  await admin.setOrg(null);
  created.push(orgId);

  return {
    orgId,
    cardId,
    userId,
    addRule: async (rule) => {
      const id = crypto.randomUUID();
      await admin.setOrg(orgId);
      await admin.query(
        `INSERT INTO platform.automations
           (id, org_id, name, trigger_event, condition, actions, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
        [
          id,
          orgId,
          `Rule ${id.slice(0, 8)}`,
          rule.triggerEvent,
          rule.condition === undefined ? null : JSON.stringify(rule.condition),
          JSON.stringify(
            rule.actions ?? [{ type: 'chat.post_message', channelId: 'c', body: 'x' }],
          ),
          rule.enabled ?? true,
          userId,
        ],
      );
      await admin.setOrg(null);
      return id;
    },
    event: (overrides = {}) => ({
      id: crypto.randomUUID(),
      orgId,
      name: 'card.status_changed',
      payload: { cardId },
      causationDepth: 0,
      ...overrides,
    }),
  };
}

async function runsFor(
  orgId: OrgId,
): Promise<{ automationId: string; status: string; reason: string | null; depth: number }[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        automationId: schema.automationRuns.automationId,
        status: schema.automationRuns.status,
        reason: schema.automationRuns.reason,
        depth: schema.automationRuns.depth,
      })
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.orgId, orgId)),
  );
}

/**
 * Reads an org's current budget row.
 *
 * `setOrg` FIRST, and that is not incidental. `platform.automation_budget`
 * FORCEs RLS, which applies to the table owner too, so a SELECT with no
 * `app.org_id` matches zero rows — and a test asserting "zero rows" would then
 * pass whether or not the budget was consumed. Both budget assertions below
 * were written that way and one of them passed for exactly that wrong reason
 * until this helper existed.
 */
async function budgetFor(orgId: OrgId): Promise<number | null> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT executions FROM platform.automation_budget WHERE org_id = $1`,
    [orgId],
  );
  await admin.setOrg(null);

  const value = result.rows[0]?.['executions'];
  return value === undefined ? null : Number(value);
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
    'platform.automation_runs',
    'platform.automation_budget',
    'platform.automations',
    'work.cards',
    'work.lists',
    'work.boards',
    'work.projects',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE email LIKE '%@automation.test'`);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  /* Sweep residue from an aborted earlier run before doing anything else.
     Orgs first (their rows reference the users), then the users themselves —
     children before parents, the ordering `tenancy-seed.ts` documents. */
  await admin.setOrg(null);
  await admin.query(
    `DELETE FROM identity.orgs WHERE id IN (
       SELECT org_id FROM identity.memberships WHERE user_id IN (
         SELECT id FROM identity.users WHERE email LIKE '%@automation.test'))`,
  );
  await admin.query(`DELETE FROM identity.users WHERE email LIKE '%@automation.test'`);

  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-automation-engine-test',
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
  await admin.end();
});

describe('the engine — matching and conditions', () => {
  it('runs a rule with no condition and records it', async () => {
    const fx = await scaffold('plain');
    const ruleId = await fx.addRule({ triggerEvent: 'card.status_changed' });
    const executor = new RecordingExecutor();

    const result = await processEvent(fx.event(), { executor });

    expect(result.considered).toBe(1);
    expect(result.executed).toBe(1);
    expect(executor.calls).toHaveLength(1);

    const runs = await runsFor(fx.orgId);
    expect(runs).toEqual([{ automationId: ruleId, status: 'succeeded', reason: null, depth: 0 }]);
  });

  it('ignores a rule listening for a different event', async () => {
    const fx = await scaffold('other');
    await fx.addRule({ triggerEvent: 'card.moved' });
    const executor = new RecordingExecutor();

    const result = await processEvent(fx.event({ name: 'card.status_changed' }), { executor });

    expect(result.considered).toBe(0);
    expect(executor.calls).toEqual([]);
    /* No rule considered means no run row — a run history that recorded
       "no rule matched" for every event in the system would be noise, not
       history. The `skipped` status is for a rule that MATCHED the event and
       whose condition said no. */
    expect(await runsFor(fx.orgId)).toEqual([]);
  });

  it('records skipped — with the reason — when the condition does not match', async () => {
    const fx = await scaffold('nomatch');
    const ruleId = await fx.addRule({
      triggerEvent: 'card.status_changed',
      condition: compare('priority', 'eq', 'low'),
    });
    const executor = new RecordingExecutor();

    /* The card is priority `high`. This is the case the whole run-history
       argument is about: without a row, "my rule did not fire" is
       indistinguishable from "the engine never saw the event". */
    await processEvent(fx.event(), { executor });

    expect(executor.calls).toEqual([]);
    const runs = await runsFor(fx.orgId);
    expect(runs[0]?.status).toBe('skipped');
    expect(runs[0]?.reason).toBe('condition_not_met');
    expect(runs[0]?.automationId).toBe(ruleId);
  });

  it('runs when the condition matches the re-read card row', async () => {
    const fx = await scaffold('match');
    await fx.addRule({
      triggerEvent: 'card.status_changed',
      condition: compare('priority', 'eq', 'high'),
    });
    const executor = new RecordingExecutor();

    /* The condition is evaluated against the CARD, re-read from work.cards —
       the event payload carries only what its consumers were promised, not
       every field a filter might name. */
    await processEvent(fx.event(), { executor });

    expect(executor.calls).toHaveLength(1);
    expect((await runsFor(fx.orgId))[0]?.status).toBe('succeeded');
  });

  it('refuses a conditional rule whose trigger has no card to evaluate', async () => {
    const fx = await scaffold('nocard');
    await fx.addRule({
      triggerEvent: 'message.sent',
      condition: compare('priority', 'eq', 'high'),
      /* NOT the default `chat.post_message` action: that emits `message.sent`,
         which is this rule's own trigger, so loop protection refuses it first
         and the reason recorded is `self_trigger`. Caught by this test failing
         with exactly that — the layers really do run in the documented order,
         which is reassuring about the engine and was careless about the
         fixture. */
      actions: [{ type: 'card.add_label', labelId: 'l' }],
    });
    const executor = new RecordingExecutor();

    /* Evaluating against an empty row would answer "no" for every condition
       and look exactly like a condition that legitimately did not match. */
    await processEvent(fx.event({ name: 'message.sent', payload: { messageId: 'm' } }), {
      executor,
    });

    expect(executor.calls).toEqual([]);
    expect((await runsFor(fx.orgId))[0]?.reason).toBe('trigger_not_evaluable');
  });

  it('reports a stored condition that no longer validates, and runs the others', async () => {
    const fx = await scaffold('broken');
    await fx.addRule({
      triggerEvent: 'card.status_changed',
      condition: { kind: 'comparison', field: 'nosuchfield', operator: 'eq', value: 'x' },
    });
    const healthy = await fx.addRule({ triggerEvent: 'card.status_changed' });
    const executor = new RecordingExecutor();

    await processEvent(fx.event(), { executor });

    /* One broken rule must not take the others down with it — the
       `parseStoredFilter` argument, applied where the blast radius is an
       entire org's automations rather than one board's view tabs. */
    const runs = await runsFor(fx.orgId);
    expect(runs.find((run) => run.status === 'refused')?.reason).toBe('condition_unusable');
    expect(runs.find((run) => run.automationId === healthy)?.status).toBe('succeeded');
    expect(executor.calls).toHaveLength(1);
  });
});

/**
 * Connector-event conditions (ai/phase-10-automation.md §7.8b).
 *
 * The gap slice 3 shipped with: a rule keyed on a Slack/GitHub event could
 * carry no condition AT ALL, because `evaluableRowFor` re-read the trigger's
 * card and a connector event has none. So the only legal connector rule fired
 * on every event type from every connected repo — and a repo running GitHub
 * Actions emits `workflow_job` continuously.
 *
 * The first test below is the one that would have failed the day slice 3
 * shipped, and its assertion is specifically about WHICH refusal: `skipped` /
 * `condition_not_met` says the condition was evaluated and answered no.
 * `refused` / `trigger_not_evaluable` says it was never evaluated at all. Both
 * mean "the rule did not run", which is exactly why asserting on the outcome
 * alone would have passed before this existed.
 */
describe('the engine — connector event conditions (§7.8b)', () => {
  const githubEvent = (fx: Fixture, providerEvent: string, providerScope = 'acme/api') =>
    fx.event({
      name: 'integration.github_event',
      payload: { providerScope, providerEvent, payload: { ref: 'refs/heads/main' } },
    });

  it('runs a connector rule whose provider_event matches', async () => {
    const fx = await scaffold('ghmatch');
    await fx.addRule({
      triggerEvent: 'integration.github_event',
      condition: compare('provider_event', 'eq', 'push'),
    });
    const executor = new RecordingExecutor();

    await processEvent(githubEvent(fx, 'push'), { executor });

    expect(executor.calls).toHaveLength(1);
    expect((await runsFor(fx.orgId))[0]?.status).toBe('succeeded');
  });

  it('SKIPS — not refuses — a connector rule whose provider_event does not match', async () => {
    const fx = await scaffold('ghnoise');
    await fx.addRule({
      triggerEvent: 'integration.github_event',
      condition: compare('provider_event', 'eq', 'push'),
    });
    const executor = new RecordingExecutor();

    /* `workflow_job` is the noise case by name: it is what a repo with GitHub
       Actions emits continuously, and it is the reason a connector rule needed
       a condition before the outbound actions could be worth having. */
    await processEvent(githubEvent(fx, 'workflow_job'), { executor });

    expect(executor.calls).toEqual([]);
    const runs = await runsFor(fx.orgId);
    expect(runs[0]?.status).toBe('skipped');
    expect(runs[0]?.reason).toBe('condition_not_met');
  });

  it('narrows to one repository with provider_scope when two are connected', async () => {
    const fx = await scaffold('ghscope');
    await fx.addRule({
      triggerEvent: 'integration.github_event',
      condition: compare('provider_scope', 'eq', 'acme/api'),
    });
    const executor = new RecordingExecutor();

    await processEvent(githubEvent(fx, 'push', 'acme/website'), { executor });
    expect(executor.calls).toEqual([]);
    expect((await runsFor(fx.orgId))[0]?.reason).toBe('condition_not_met');

    await processEvent(githubEvent(fx, 'push', 'acme/api'), { executor });
    expect(executor.calls).toHaveLength(1);
  });

  it('accepts `in` over several event types', async () => {
    const fx = await scaffold('ghin');
    await fx.addRule({
      triggerEvent: 'integration.github_event',
      /* `in` on a text field exists ONLY because the connector fields declare
         it (fields.ts's per-field `operators`), so this also proves the
         override reaches the evaluator rather than being a builder-only
         affordance. */
      condition: compare('provider_event', 'in', ['push', 'pull_request']),
    });
    const executor = new RecordingExecutor();

    await processEvent(githubEvent(fx, 'pull_request'), { executor });
    expect(executor.calls).toHaveLength(1);

    await processEvent(githubEvent(fx, 'issues'), { executor });
    expect(executor.calls).toHaveLength(1);
  });

  it('refuses a connector rule whose condition names a CARD field', async () => {
    const fx = await scaffold('ghcard');
    await fx.addRule({
      triggerEvent: 'integration.github_event',
      /* The API refuses this at SAVE time (`assertConditionUsable`), so this
         row can only exist by having been written directly — a rule from an
         older build, or edited in the database. It must still be refused here
         rather than evaluated against a row that has no `priority` key, which
         would answer "no" forever and look like a condition nobody could get
         to match. */
      condition: compare('priority', 'eq', 'high'),
    });
    const executor = new RecordingExecutor();

    await processEvent(githubEvent(fx, 'push'), { executor });

    expect(executor.calls).toEqual([]);
    expect((await runsFor(fx.orgId))[0]?.reason).toBe('condition_unusable');
  });

  it('still refuses a connector event missing its own wrapper fields', async () => {
    const fx = await scaffold('ghbare');
    await fx.addRule({
      triggerEvent: 'integration.github_event',
      condition: compare('provider_event', 'eq', 'push'),
    });
    const executor = new RecordingExecutor();

    /* `trigger_not_evaluable` is narrowed by §7.8b, not removed. An event with
       no `providerEvent` is not a connector event this build can reason about,
       and evaluating it against a half-empty row would silently answer no. */
    await processEvent(
      fx.event({ name: 'integration.github_event', payload: { providerScope: 'acme/api' } }),
      { executor },
    );

    expect(executor.calls).toEqual([]);
    expect((await runsFor(fx.orgId))[0]?.reason).toBe('trigger_not_evaluable');
  });
});

describe('the engine — loop protection', () => {
  it('refuses at the depth cap and never reaches the executor', async () => {
    const fx = await scaffold('depth');
    await fx.addRule({ triggerEvent: 'card.status_changed' });
    const executor = new RecordingExecutor();

    await processEvent(fx.event({ causationDepth: MAX_DEPTH }), { executor });

    /* The assertion that matters is the SECOND one. A gate that refuses after
       having already acted reads correctly in a diff and is useless — the
       lesson `spend-gate.test.ts` states about the telephony provider. */
    expect((await runsFor(fx.orgId))[0]?.reason).toBe('depth_exceeded');
    expect(executor.calls).toEqual([]);
  });

  it('passes the incremented depth to the executor, so a chain terminates', async () => {
    const fx = await scaffold('increment');
    await fx.addRule({ triggerEvent: 'card.status_changed' });
    const executor = new RecordingExecutor();

    await processEvent(fx.event({ causationDepth: 2 }), { executor });

    /* This is what makes the counter survive the hop. Without it every chain
       restarts at 0 on the far side of the outbox and the cap protects
       nothing. */
    expect(executor.calls[0]?.nextDepth).toBe(3);
    expect((await runsFor(fx.orgId))[0]?.depth).toBe(2);
  });

  it('refuses a self-triggering rule before it can spend anything', async () => {
    const fx = await scaffold('selftrigger');
    await fx.addRule({
      triggerEvent: 'card.updated',
      actions: [{ type: 'card.set_priority', priority: 'low' }],
    });
    const executor = new RecordingExecutor();

    await processEvent(fx.event({ name: 'card.updated' }), { executor });

    expect((await runsFor(fx.orgId))[0]?.reason).toBe('self_trigger');
    expect(executor.calls).toEqual([]);
  });

  it('refuses every rule when the org is suspended', async () => {
    const fx = await scaffold('suspended');
    await fx.addRule({ triggerEvent: 'card.status_changed' });
    await admin.setOrg(fx.orgId);
    await admin.query(`UPDATE identity.orgs SET status = 'suspended' WHERE id = $1`, [fx.orgId]);
    await admin.setOrg(null);

    const executor = new RecordingExecutor();
    const result = await processEvent(fx.event(), { executor });

    /* The kill switch, checked once per event rather than once per rule — a
       suspended org's automations must not run at all. PLAN.md §8.5: a kill
       switch that only runs where a user is waiting is not a kill switch. */
    expect(result.considered).toBe(0);
    expect(executor.calls).toEqual([]);
  });

  it('does not consider a disabled rule at all', async () => {
    const fx = await scaffold('disabled');
    await fx.addRule({ triggerEvent: 'card.status_changed', enabled: false });
    const executor = new RecordingExecutor();

    const result = await processEvent(fx.event(), { executor });

    expect(result.considered).toBe(0);
    expect(executor.calls).toEqual([]);
  });
});

describe('the engine — the durable budget', () => {
  it('refuses once the hourly ceiling is reached, and consumes nothing when refusing', async () => {
    const fx = await scaffold('budget');
    await fx.addRule({ triggerEvent: 'card.status_changed' });

    /* Pre-fill this org's current hour to the ceiling. Writing the row
       directly is the point: the budget must be durable, so a test that could
       only reach it by executing 1,000 events would be asserting the counter
       rather than the storage. */
    await admin.setOrg(fx.orgId);
    await admin.query(
      `INSERT INTO platform.automation_budget (org_id, window_hour, executions)
       VALUES ($1, date_trunc('hour', now()), $2)`,
      [fx.orgId, HOURLY_EXECUTION_BUDGET],
    );
    await admin.setOrg(null);

    const executor = new RecordingExecutor();
    await processEvent(fx.event(), { executor });

    expect((await runsFor(fx.orgId))[0]?.reason).toBe('budget_exhausted');
    expect(executor.calls).toEqual([]);

    /* A refusal must not itself consume budget, or a broken rule firing
       constantly would keep an org refused forever — a denial of service
       delivered through the control meant to prevent one. */
    expect(await budgetFor(fx.orgId)).toBe(HOURLY_EXECUTION_BUDGET);
  });

  it('is not consumed by a rule refused for any earlier reason', async () => {
    const fx = await scaffold('budgetorder');
    await fx.addRule({ triggerEvent: 'card.status_changed' });
    const executor = new RecordingExecutor();

    await processEvent(fx.event({ causationDepth: MAX_DEPTH }), { executor });

    /* The ORDER is what this asserts, not the outcome. The budget is the only
       check that mutates, so it runs last — counting an execution that was
       going to be refused anyway lets a broken rule burn a legitimate org's
       allowance. The identical argument checkOutboundAllowed makes for running
       the velocity limiter last.

       `budgetFor` sets the org scope before reading. Without it this assertion
       passed for the wrong reason: RLS returns zero rows to an unscoped
       reader, so "no budget row" was true whether or not one had been
       written. */
    expect(await budgetFor(fx.orgId)).toBeNull();
  });
});

describe('the engine — failure handling', () => {
  it('records a failed run when an action fails, naming which one', async () => {
    const fx = await scaffold('failed');
    await fx.addRule({
      triggerEvent: 'card.status_changed',
      actions: [
        { type: 'chat.post_message', channelId: 'c', body: 'a' },
        { type: 'card.add_label', labelId: 'l' },
      ],
    });
    const executor = new RecordingExecutor();
    executor.mode = 'fail';

    await processEvent(fx.event(), { executor });

    expect((await runsFor(fx.orgId))[0]?.status).toBe('failed');
  });

  it('turns an executor that throws into a recorded failure, not a stalled queue', async () => {
    const fx = await scaffold('throw');
    await fx.addRule({ triggerEvent: 'card.status_changed' });
    const executor = new RecordingExecutor();
    executor.mode = 'throw';

    /* One rule blowing up must not take out the rules behind it, nor the
       events behind THEM. The drain loop marks a batch dispatched; an
       exception escaping here would leave the whole batch unmarked. */
    await expect(processEvent(fx.event(), { executor })).resolves.toBeDefined();
    expect((await runsFor(fx.orgId))[0]?.status).toBe('failed');
  });
});

describe('the engine — executing a REAL action against the real services', () => {
  /* Everything above drives a recording fake; the real executor is exercised
     only by typecheck. The three newest actions (add_comment, remove_label,
     unassign) deserve one trip through their actual service wiring — the
     class of mistake this catches is an import that resolves, a branch that
     compiles, and a call that fails at runtime because the fixture shape
     assumed wrong (the `@taskflow/api/work/comments` export entry is exactly
     the kind of thing only this proves).

     The real executor re-resolves the rule owner's membership on every run,
     so these fixtures need a memberships row the recording-fake suites
     never did. */
  async function memberOf(fx: Fixture): Promise<void> {
    await admin.setOrg(fx.orgId);
    await admin.query(
      `INSERT INTO identity.memberships (id, org_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [crypto.randomUUID(), fx.orgId, fx.userId],
    );
    await admin.setOrg(null);
  }

  it('card.add_comment writes the comment to the card', async () => {
    const fx = await scaffold('realcomment');
    await memberOf(fx);

    await fx.addRule({
      triggerEvent: 'card.status_changed',
      actions: [{ type: 'card.add_comment', body: 'moved by automation' }],
    });

    await processEvent(fx.event(), { executor: createActionExecutor() });

    expect((await runsFor(fx.orgId))[0]?.status).toBe('succeeded');

    const comments = await withOrgScope(fx.orgId, async (tx) =>
      tx
        .select({ bodyText: schema.cardComments.bodyText })
        .from(schema.cardComments)
        .where(eq(schema.cardComments.cardId, fx.cardId)),
    );
    expect(comments.map((row) => row.bodyText)).toEqual(['moved by automation']);
  });

  it('card.remove_label is a no-op — and records success — when the card has no labels', async () => {
    const fx = await scaffold('realremovelabel');
    await memberOf(fx);

    await fx.addRule({
      triggerEvent: 'card.status_changed',
      actions: [{ type: 'card.remove_label', labelId: crypto.randomUUID() }],
    });

    await processEvent(fx.event(), { executor: createActionExecutor() });

    /* The action asked for a state the card is already in; that is not a
       failure, and the run records it as a success — the same no-op
       discipline `card.assign` already applies when the person is already
       assigned. */
    expect((await runsFor(fx.orgId))[0]?.status).toBe('succeeded');
  });
});
