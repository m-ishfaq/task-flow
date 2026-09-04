import { describe, expect, it } from 'vitest';
import type { KeyProvider, WrappedDataKey, DataKey } from '@taskflow/contracts';
import type { DomainEvent } from '@taskflow/events';
import { createEvent } from '@taskflow/events';
import { cardCreated } from '@taskflow/api/events/work';
import { hashToken, issueToken } from '@taskflow/security';
import { createRng, findProfile, type SeedContext, type SeedDb } from './index.js';
import { envelopeFor } from './support.js';
import type { SeededOrg, SeededMembership, SeededTeam } from './modules/tenancy.orgs.js';
import type { SeededProject, SeededStatus, SeededLabel } from './modules/work.projects.js';
import type { SeededChannel } from './modules/chat.channels.js';
import type { ChannelPlan } from './profiles.js';
import { DEFAULT_SPRINTS, sprintsModule } from './modules/work.sprints.js';
import { automationsModule } from './modules/platform.automations.js';
import { webhooksModule } from './modules/platform.webhooks.js';
import { apiTokensModule } from './modules/platform.api-tokens.js';
import { orgsModule } from './modules/tenancy.orgs.js';
import { projectsModule } from './modules/work.projects.js';
import { cardsModule } from './modules/work.cards.js';
import { channelsModule } from './modules/chat.channels.js';
import type { SeedModule } from './registry.js';

/**
 * The four Phase 10/10.5 seed modules, held to the invariants the DATABASE
 * does not enforce — and to the constraints it does.
 *
 * Like docs.test.ts this needs no database: the properties under test are
 * shape, arithmetic and scoping, and the RLS/composite-FK halves belong to
 * `packages/db`'s suites. The fake context captures INSERTs and UPDATEs with
 * the org scope in force, so the "every write happens under orgScope" rule
 * (context.ts's own warning) is asserted rather than assumed — a module that
 * forgot it would write rows RLS silently drops, and the run would finish
 * green with tables that stayed empty.
 */

function id(kind: string, index: number): string {
  return `00000000-0000-7000-8000-${kind}${String(index).padStart(8, '0')}`;
}

function membership(index: number, role: SeededMembership['role']): SeededMembership {
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

function seededOrg(): SeededOrg {
  const memberships: readonly SeededMembership[] = [
    membership(0, 'owner'),
    membership(1, 'member'),
    membership(2, 'member'),
  ];
  const owner = memberships[0]?.user;
  if (owner === undefined) throw new Error('fixture has no owner');
  const teams: readonly SeededTeam[] = [
    { id: id('7e', 1), name: 'Core', slug: 'core', members: memberships.map((m) => m.user) },
  ];

  return {
    id: ORG_ID,
    name: 'Test Org',
    slug: 'test-org',
    plan: {
      name: 'Test Org',
      slug: 'test-org',
      grants: 0,
      teams: ['Core'],
      members: memberships.map((m, i) => ({ user: i, role: m.role })),
      channels: [],
      projects: [],
      spaces: [],
    },
    owner,
    memberships,
    teams,
    members: memberships.map((m) => m.user),
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
  };
}

function seededProject(org: SeededOrg): SeededProject {
  const statuses: readonly SeededStatus[] = [
    { id: id('b1', 1), name: 'To Do', category: 'not_started', isDefault: true },
    { id: id('b1', 2), name: 'In Progress', category: 'active', isDefault: false },
    { id: id('b1', 3), name: 'Done', category: 'done', isDefault: false },
  ];
  const labels: readonly SeededLabel[] = [{ id: id('c1', 1), name: 'Bug', color: '#e5484d' }];
  return {
    id: id('b0', 1),
    orgId: org.id,
    org,
    name: 'Test Project',
    key: 'WEB',
    plan: {
      name: 'Test Project',
      key: 'WEB',
      boards: [],
      labels: 1,
      customFields: 'standard',
    },
    statuses,
    defaultStatusId: statuses[0]?.id ?? '',
    labels,
    customFieldDefs: [],
    archived: false,
    createdAt: org.createdAt,
  };
}

function seededChannel(org: SeededOrg): SeededChannel {
  const plan: ChannelPlan = { name: 'general', type: 'public', members: 3, messages: 4 };
  const creator = org.memberships[0];
  if (creator === undefined) throw new Error('fixture has no channel creator');
  return {
    id: id('d1', 1),
    orgId: org.id,
    org,
    type: 'public',
    name: 'general',
    plan,
    members: org.memberships,
    creator,
    createdAt: org.createdAt,
    archivedAt: null,
  };
}

/** A KeyProvider that never touches real crypto — the module only stores. */
function fakeKeysProvider(): KeyProvider {
  // AES-256-GCM demands a 32-byte key (`encryptString` asserts it) — a
  // shorter fixture would fail before any assertion ran.
  const material = new Uint8Array(32).map((_, index) => (index + 1) % 256);
  const wrapped: WrappedDataKey = {
    wrapped: new Uint8Array([16, 15, 14, 13]),
    masterKeyId: 'test-master',
  };
  const plaintext: DataKey = { key: material, masterKeyId: 'test-master' };
  return {
    currentMasterKeyId: 'test-master',
    generateDataKey: () => Promise.resolve({ plaintext, wrapped }),
    unwrapDataKey: () => Promise.resolve(plaintext),
    rewrapDataKey: () => Promise.resolve(wrapped),
  };
}

interface Harness {
  readonly ctx: SeedContext;
  readonly inserts: {
    table: string;
    columns: readonly string[];
    rows: readonly (readonly unknown[])[];
    orgId: string | null;
  }[];
  readonly queries: { text: string; values: readonly unknown[]; orgId: string | null }[];
  readonly events: DomainEvent[];
  rowsOf(table: string): readonly (readonly unknown[])[];
  columnsOf(table: string): readonly string[];
}

function harnessFor(
  org: SeededOrg,
  options?: { keys?: KeyProvider | null; cardEvents?: readonly DomainEvent[] },
): Harness {
  const inserts: Harness['inserts'] = [];
  const queries: Harness['queries'] = [];
  const events: DomainEvent[] = [...(options?.cardEvents ?? [])];
  let currentOrg: string | null = null;

  const db: SeedDb = {
    query: (text, values = []) => {
      queries.push({ text, values, orgId: currentOrg });
      return Promise.resolve([]);
    },
    insert: (table, columns, rows) => {
      inserts.push({ table, columns, rows, orgId: currentOrg });
      return Promise.resolve(rows.length);
    },
  };

  const outputs = new Map<SeedModule, unknown>();
  outputs.set(orgsModule, { orgs: [org] });
  const project = seededProject(org);
  outputs.set(projectsModule, { projects: [project] });
  // The sprints module requires cards but never reads its output — the
  // dependency is ordering-only (the card ids come from buffered events).
  outputs.set(cardsModule, { cardRefs: [], cardCount: 0 });
  outputs.set(channelsModule, { channels: [seededChannel(org)] });

  const ctx: SeedContext = {
    db,
    rng: createRng('platform-automation-test'),
    profile: findProfile('demo'),
    now: new Date('2026-08-12T12:00:00.000Z'),
    chaos: false,
    reseedPlans: false,
    payments: null,
    storage: null,
    telephony: null,
    keys: options?.keys ?? null,
    platformOperator: null,
    log: () => undefined,
    use: <Out>(module: SeedModule<Out>): Out => {
      const output = outputs.get(module);
      if (output === undefined) throw new Error(`no output recorded for ${module.name}`);
      return output as Out;
    },
    emit: (event) => {
      events.push(event);
      return events.length;
    },
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
    queries,
    events,
    rowsOf: (table) => inserts.filter((i) => i.table === table).flatMap((i) => [...i.rows]),
    columnsOf: (table) => inserts.find((i) => i.table === table)?.columns ?? [],
  };
}

/** Column-name → value, so assertions read as rows rather than as indices. */
function asRecords(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): readonly Record<string, unknown>[] {
  const names = columns.map((column) => column.split('::')[0] ?? column);
  return rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

/** The card ids this fixture's project "has" — used for the sprint tests. */
const CARD_IDS = [
  id('f1', 1),
  id('f1', 2),
  id('f1', 3),
  id('f1', 4),
  id('f1', 5),
  id('f1', 6),
  id('f1', 7),
  id('f1', 8),
  id('f1', 9),
];

function cardCreatedEvent(org: SeededOrg, cardId: string): DomainEvent {
  return createEvent(
    cardCreated,
    {
      cardId,
      boardId: id('e1', 1),
      listId: id('e2', 1),
      projectId: id('b0', 1),
      reference: 'WEB-1',
      title: 'Seeded card',
    },
    envelopeFor(org.id, org.owner.id, org.createdAt),
  );
}

/* -------------------------------------------------------------------------- *
 * work.sprints
 * -------------------------------------------------------------------------- */

describe('work.sprints', () => {
  it('seeds exactly one sprint per lifecycle state, all scoped to the org', async () => {
    const org = seededOrg();
    const harness = harnessFor(org, {
      cardEvents: CARD_IDS.map((cardId) => cardCreatedEvent(org, cardId)),
    });
    const output = await sprintsModule.seed(harness.ctx);

    const sprints = asRecords(harness.columnsOf('work.sprints'), harness.rowsOf('work.sprints'));

    /* A HISTORY now, not one sprint per state: `DEFAULT_SPRINTS` closed
       sprints, exactly one active, and the planned run ahead of it. The count
       is derived from the shape rather than written as a literal, so raising
       the default does not silently make this assertion meaningless. */
    const expected = DEFAULT_SPRINTS.completed + 1 + DEFAULT_SPRINTS.planned;
    expect(sprints).toHaveLength(expected);

    const byStatus = (status: string) => sprints.filter((s) => s['status'] === status).length;
    expect(byStatus('completed')).toBe(DEFAULT_SPRINTS.completed);
    expect(byStatus('planned')).toBe(DEFAULT_SPRINTS.planned);
    /* The one that matters: `work.sprints` carries a unique index allowing a
       single active sprint per project, so a generator emitting two would fail
       the first real `pnpm seed` rather than this test. */
    expect(byStatus('active')).toBe(1);

    // Every write happens under the org scope — RLS would silently drop
    // anything issued without it (context.ts's warning).
    for (const insert of harness.inserts) expect(insert.orgId).toBe(org.id);
    for (const query of harness.queries) expect(query.orgId).toBe(org.id);

    // The active sprint carries its lifecycle timestamps; the planned one
    // carries neither.
    const active = sprints.find((s) => s['status'] === 'active');
    const planned = sprints.find((s) => s['status'] === 'planned');
    expect(active?.['started_at']).toBeTruthy();
    expect(active?.['completed_at']).toBeNull();
    expect(planned?.['started_at']).toBeNull();
    expect(planned?.['completed_at']).toBeNull();

    // dates are ordered, per the migration CHECK.
    for (const sprint of sprints) {
      const startsOn = String(sprint['starts_on']);
      const endsOn = String(sprint['ends_on']);
      expect(endsOn >= startsOn).toBe(true);
    }

    expect(output.sprintCount).toBe(expected);
  });

  it('assigns the card.created card ids to the active sprint via a scoped UPDATE', async () => {
    const org = seededOrg();
    const harness = harnessFor(org, {
      cardEvents: CARD_IDS.map((cardId) => cardCreatedEvent(org, cardId)),
    });
    await sprintsModule.seed(harness.ctx);

    /* Cards are handed out oldest-sprint-first and NEVER reused — a card
       belongs to at most one sprint (`work.cards.sprint_id` is one column),
       so overlapping slices would silently move a card to whichever sprint was
       written last. Each closed sprint takes two, then the active one takes up
       to five from whatever is left.

       Asserted as a PARTITION rather than against literal indices: the exact
       offsets move whenever `DEFAULT_SPRINTS` changes, and an assertion that
       has to be recomputed by hand each time is one that gets loosened
       instead. What must stay true is that no card appears twice. */
    const updates = harness.queries.filter((q) => q.text.includes('UPDATE work.cards'));
    const assigned = updates.flatMap((q) => q.values[3] as readonly string[]);
    expect(new Set(assigned).size, 'a card was assigned to two sprints').toBe(assigned.length);
    expect(assigned.every((id) => CARD_IDS.includes(id))).toBe(true);

    // Every write stays inside the org scope. [sprintId, updated_at, orgId, cardIds]
    for (const update of updates) expect(update.values[2]).toBe(org.id);

    /* The active sprint gets the widest slice of the ones that have cards —
       it is the board a demo actually opens. */
    const widest = Math.max(...updates.map((q) => (q.values[3] as readonly string[]).length));
    expect(widest).toBeGreaterThanOrEqual(2);
  });

  it('emits sprint.created for every sprint and sprint.completed for the closed one', async () => {
    const org = seededOrg();
    const harness = harnessFor(org);
    await sprintsModule.seed(harness.ctx);

    const created = harness.events.filter((e) => e.name === 'sprint.created');
    expect(created).toHaveLength(DEFAULT_SPRINTS.completed + 1 + DEFAULT_SPRINTS.planned);

    /* One `sprint.completed` per closed sprint, not merely 'at least one' —
       a generator that emitted the lifecycle event for only the newest of a
       run would leave the older ones with a creation event and no closure,
       which reads in an audit trail as sprints that never ended. */
    const closed = harness.events.filter((e) => e.name === 'sprint.completed');
    expect(closed).toHaveLength(DEFAULT_SPRINTS.completed);
    expect(harness.events.some((e) => e.name === 'sprint.started')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * platform.automations
 * -------------------------------------------------------------------------- */

describe('platform.automations', () => {
  it('writes rules with real ids and every action parseable as JSON', async () => {
    const org = seededOrg();
    const harness = harnessFor(org);
    const output = await automationsModule.seed(harness.ctx);

    const rules = asRecords(
      harness.columnsOf('platform.automations'),
      harness.rowsOf('platform.automations'),
    );
    // Every project gets the priority rule; the triage and announce rules
    // need a label and a channel, which the fixture provides.
    expect(rules.length).toBeGreaterThanOrEqual(3);

    for (const rule of rules) {
      expect(rule['org_id']).toBe(org.id);
      expect(rule['created_by']).toBe(org.owner.id);
      const actions = rule['actions'];
      expect(Array.isArray(actions)).toBe(true);
      expect((actions as readonly unknown[]).length).toBeGreaterThan(0);
      // The actions JSON must survive a JSON round-trip — jsonb only accepts
      // what stringifies.
      expect(JSON.stringify(actions)).toBeTruthy();
    }

    // The announce rule carries the two-argument chat.post_message action.
    const announce = rules.find((r) => String(r['name']).includes('announce'));
    expect(announce).toBeDefined();
    const postMessage = (announce?.['actions'] as readonly Record<string, unknown>[]).find(
      (a) => a['type'] === 'chat.post_message',
    );
    expect(postMessage?.['body']).toBeTruthy();
    expect(String(postMessage?.['channelId']).length).toBeGreaterThan(0);

    // The triage rule's condition references the seeded label id.
    const triage = rules.find((r) => String(r['name']).includes('triage'));
    expect(triage).toBeDefined();
    const condition = triage!['condition'] as { kind?: string; field?: string; value?: unknown[] };
    expect(condition.kind).toBe('comparison');
    expect(condition.field).toBe('label');
    expect(condition.value).toEqual([id('c1', 1)]);

    expect(output.ruleCount).toBe(rules.length);
  });
});

/* -------------------------------------------------------------------------- *
 * platform.webhooks
 * -------------------------------------------------------------------------- */

describe('platform.webhooks', () => {
  it('skips entirely when no key provider is configured', async () => {
    const org = seededOrg();
    const harness = harnessFor(org, { keys: null });
    const output = await webhooksModule.seed(harness.ctx);

    expect(output.webhookCount).toBe(0);
    expect(output.signingSecret).toBeNull();
    expect(harness.rowsOf('platform.webhooks')).toHaveLength(0);
  });

  it('writes one webhook per org with a wrapped signing key and a one-time secret', async () => {
    const org = seededOrg();
    const harness = harnessFor(org, { keys: fakeKeysProvider() });
    const output = await webhooksModule.seed(harness.ctx);

    const hooks = asRecords(
      harness.columnsOf('platform.webhooks'),
      harness.rowsOf('platform.webhooks'),
    );
    expect(hooks).toHaveLength(1);
    const hook = hooks[0];
    expect(hook?.['org_id']).toBe(org.id);
    expect(hook?.['signing_key_master_id']).toBe('test-master');
    expect(hook?.['signing_key_ciphertext']).toBeInstanceOf(Buffer);
    expect(String(hook?.['url'])).toMatch(/^https?:\/\//);

    // The secret is minted through the real path and shown exactly once.
    const issued = issueToken('webhookSigning');
    expect(output.signingSecret).toMatch(/^tf_whs_/);
    expect(output.signingSecret).not.toBe(issued.token);
  });
});

/* -------------------------------------------------------------------------- *
 * platform.api-tokens
 * -------------------------------------------------------------------------- */

describe('platform.api-tokens', () => {
  it('stores the hash, never the token, with a 10-char prefix and non-empty scopes', async () => {
    const org = seededOrg();
    const harness = harnessFor(org);
    const output = await apiTokensModule.seed(harness.ctx);

    const tokens = asRecords(
      harness.columnsOf('platform.api_tokens'),
      harness.rowsOf('platform.api_tokens'),
    );
    expect(tokens).toHaveLength(1);
    const token = tokens[0];

    // The migration enforces these shapes (hash length, prefix length, scopes
    // non-empty) — the seed must produce them by construction.
    expect(String(token?.['token_hash'])).toHaveLength(64);
    expect(String(token?.['token_prefix'])).toHaveLength(10);
    expect(token?.['scopes']).toEqual(['card:read']);
    expect(token?.['org_id']).toBe(org.id);

    // The plaintext is shown once and only the hash is stored.
    expect(output.token).toMatch(/^tf_pat_/);
    expect(String(token?.['token_hash'])).toBe(hashToken(String(output.token)));
  });
});
