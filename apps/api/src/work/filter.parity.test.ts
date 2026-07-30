import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type BoardId,
  type LabelId,
  type ListId,
  type OrgId,
  type ProjectId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { ME, and, compare, evaluate, not, or, type FilterNode } from '@taskflow/filter';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import * as labels from './label.service.js';
import type { WorkActor } from './shared.js';

/**
 * Compiler / evaluator parity, against real Postgres (PLAN.md §10.2).
 *
 * The filter AST has two backends: a SQL compiler for board views (Phase 3) and
 * an in-memory evaluator for automation conditions (Phase 10). **They must
 * select the same cards.**
 *
 * If they disagree, a rule fires on work the user cannot see in the view that
 * supposedly describes it — and nothing fails, because each half is
 * individually reasonable. The disagreement is only visible by running both
 * against the same rows, which is what this file does.
 *
 * Real Postgres, not a stub, because the interesting disagreements are exactly
 * the ones a JavaScript reimplementation of SQL gets wrong: three-valued logic,
 * `ILIKE` versus `includes`, timestamps compared as instants versus as text.
 */

const OWNER = unsafeAsId<'UserId'>('0195f100-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195f100-0000-7000-8000-000000000002');
const requestId = unsafeAsId<'RequestId'>('0195f100-0000-7000-8000-0000000000ff');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@parity.test'],
  [MEMBER, 'member@parity.test'],
];

let admin: AdminConnection;
let orgId: OrgId;
let owner: WorkActor;
let boardId: BoardId;
let projectId: ProjectId;
let todo: ListId;
let doing: ListId;
let bug: LabelId;
let chore: LabelId;

/** The rows, as the evaluator sees them — keyed by FIELD name, not column. */
const expectedRows = new Map<string, Record<string, unknown>>();

async function actorFor(userId: UserId, role: Subject['role']): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function removeOrg(id: string): Promise<void> {
  await admin.setOrg(id);
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'work.card_labels',
    'work.labels',
    'work.cards',
    'work.lists',
    'work.boards',
    'work.projects',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [id]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [id]);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-parity-test' });

  const org = await orgs.createOrg(
    { name: 'Parity', slug: 'filter-parity' },
    { userId: OWNER, requestId },
  );
  orgId = org.orgId;
  owner = await actorFor(OWNER, 'owner');

  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  projectId = project.projectId;

  const board = await boards.createBoard(owner, { projectId, name: 'Delivery' });
  boardId = board.boardId;

  todo = (await lists.createList(owner, { boardId, name: 'Todo', wipLimit: null })).listId;
  doing = (await lists.createList(owner, { boardId, name: 'Doing', wipLimit: null })).listId;

  bug = (await labels.createLabel(owner, { projectId, name: 'bug', color: '#ef4444' })).labelId;
  chore = (await labels.createLabel(owner, { projectId, name: 'chore', color: '#22c55e' })).labelId;

  /* A deliberately awkward corpus. Every row exists to make one of the
     SQL/JavaScript disagreements observable: nulls, mixed case, a timezone
     offset, an empty assignee array, a LIKE metacharacter. */
  const corpus: {
    title: string;
    listId: ListId;
    due: string | null;
    assignees: readonly UserId[];
    /* Labels matter here for the same reason the assignee cases do: `label` is
       an aggregate over another table, so it is the one field where "no rows"
       and "an empty set" are produced by the database rather than written by
       the seed. A card with none must be distinguishable from one with some. */
    labels: readonly LabelId[];
  }[] = [
    {
      title: 'Ship the thing',
      listId: todo,
      due: '2026-07-29T00:00:00Z',
      assignees: [OWNER],
      labels: [bug],
    },
    { title: 'SHIP louder', listId: todo, due: null, assignees: [], labels: [bug, chore] },
    {
      title: 'Discount 50% off',
      listId: doing,
      due: '2026-08-01T12:00:00Z',
      assignees: [MEMBER],
      labels: [chore],
    },
    {
      title: 'Timezone edge',
      listId: doing,
      due: '2026-07-29T00:30:00+01:00',
      assignees: [OWNER],
      labels: [],
    },
    {
      title: 'no assignees at all',
      listId: todo,
      due: '2026-06-01T00:00:00Z',
      assignees: [],
      labels: [],
    },
    { title: 'Both of us', listId: doing, due: null, assignees: [OWNER, MEMBER], labels: [] },
  ];

  for (const entry of corpus) {
    const card = await cards.createCard(owner, {
      listId: entry.listId,
      title: entry.title,
      description: null,
    });

    if (entry.due !== null || entry.assignees.length > 0) {
      await admin.setOrg(orgId);
      await admin.query(
        `UPDATE work.cards SET due_date = $2::timestamptz, assignee_ids = $3::uuid[] WHERE id = $1`,
        [card.cardId, entry.due, [...entry.assignees]],
      );
      await admin.setOrg(null);
    }

    if (entry.labels.length > 0) {
      await labels.setCardLabels(owner, {
        cardId: unsafeAsId<'CardId'>(card.cardId),
        labelIds: entry.labels,
      });
    }

    expectedRows.set(card.cardId, {
      title: entry.title,
      list: entry.listId,
      board: boardId,
      project: projectId,
      due: entry.due,
      assignee: [...entry.assignees],
      creator: OWNER,
      archived: false,
      description: null,
      comments: 0,
      /* `array_agg` over no rows is NULL, not an empty array. The evaluator's
         row has to say the same thing, or `label is_empty` would agree for the
         wrong reason. */
      label: entry.labels.length === 0 ? null : [...entry.labels],
    });
  }
}, 60_000);

afterAll(async () => {
  await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

/**
 * Runs a filter through BOTH backends and asserts they select the same cards.
 *
 * The assertion is on the ids, not the counts: two backends returning three
 * cards each is not agreement if they are different threes.
 */
async function expectParity(filter: FilterNode): Promise<readonly string[]> {
  const fromSql = await cards.listCards(owner, { boardId, filter });
  const viaSql = fromSql.map((card) => card.cardId).sort();

  const viaEvaluator = [...expectedRows.entries()]
    .filter(([, row]) => evaluate('card', filter, row, { viewerId: OWNER }))
    .map(([cardId]) => cardId)
    .sort();

  expect(viaEvaluator, `SQL and the evaluator disagreed on ${JSON.stringify(filter)}`).toEqual(
    viaSql,
  );
  return viaSql;
}

describe('the two backends agree', () => {
  it('on a simple equality', async () => {
    const matched = await expectParity(compare('title', 'eq', 'Ship the thing'));
    expect(matched).toHaveLength(1);
  });

  it('on a case-insensitive contains', async () => {
    // ILIKE is case-insensitive; `includes` is not. Both rows must match.
    const matched = await expectParity(compare('title', 'contains', 'ship'));
    expect(matched).toHaveLength(2);
  });

  it('on a LIKE metacharacter treated as a literal', async () => {
    // Without escaping, '50%' matches everything beginning '50'.
    const matched = await expectParity(compare('title', 'contains', '50%'));
    expect(matched).toHaveLength(1);
  });

  it('on a null comparison', async () => {
    const matched = await expectParity(compare('due', 'is_empty'));
    expect(matched).toHaveLength(2);
  });

  it('on a range that excludes nulls — SQL three-valued logic', async () => {
    /* The disagreement a naive evaluator produces: in Postgres a row with a
       NULL due date matches neither `due < x` nor its negation, because the
       comparison is UNKNOWN rather than false. */
    await expectParity(compare('due', 'lt', '2026-07-30T00:00:00Z'));
    await expectParity(not(compare('due', 'lt', '2026-07-30T00:00:00Z')));
  });

  it('on a timestamp with an offset compared against one in UTC', async () => {
    /* `2026-07-29T00:30:00+01:00` sorts AFTER `...Z` as text and BEFORE it as
       an instant. Postgres compares instants, so the evaluator must too. */
    await expectParity(compare('due', 'lt', '2026-07-29T00:15:00Z'));
  });

  it('on array membership', async () => {
    const matched = await expectParity(compare('assignee', 'in', [MEMBER]));
    expect(matched).toHaveLength(2);
  });

  it('on an empty array versus a null one', async () => {
    await expectParity(compare('assignee', 'is_empty'));
    await expectParity(compare('assignee', 'is_not_empty'));
  });

  it('on @me, resolved to the same viewer on both sides', async () => {
    const matched = await expectParity(compare('assignee', 'in', [ME]));
    expect(matched).toHaveLength(3);
  });

  /**
   * The label field, which had no test and was broken in both backends.
   *
   * `label` compiles to an aggregate subquery returning `uuid[]`, and it was
   * declared `type: 'uuid'`. That made the compiler emit `uuid[] = uuid` — an
   * operator Postgres does not have, so every label filter was a 500 — while the
   * evaluator took the scalar path and silently matched nothing. Two backends,
   * two different wrong answers, no failing test.
   *
   * These cases are what make the `uuid_array` declaration in fields.ts a fact
   * rather than a claim.
   */
  describe('on labels, which are an aggregate over another table', () => {
    it('finds cards carrying one of several labels', async () => {
      const matched = await expectParity(compare('label', 'in', [bug]));
      expect(matched).toHaveLength(2);

      const either = await expectParity(compare('label', 'in', [bug, chore]));
      // Overlap, not containment: "SHIP louder" has both and is counted once.
      expect(either).toHaveLength(3);
    });

    it('separates an unlabelled card from a labelled one', async () => {
      const none = await expectParity(compare('label', 'is_empty'));
      expect(none).toHaveLength(3);

      const some = await expectParity(compare('label', 'is_not_empty'));
      expect(some).toHaveLength(3);
    });

    it('excludes a label without swallowing the cards that have none', async () => {
      /* The three-valued trap: `array_agg` is NULL for an unlabelled card, so a
         bare `NOT (labels && ...)` is UNKNOWN there and Postgres drops the row.
         The compiler's COALESCE is what keeps those cards in the result, and
         the evaluator has to agree. */
      const matched = await expectParity(compare('label', 'not_in', [bug]));
      expect(matched).toHaveLength(4);
    });

    it('composes with another predicate', async () => {
      await expectParity(and(compare('label', 'in', [chore]), compare('due', 'is_not_empty')));
    });
  });

  it('on a nested boolean expression', async () => {
    await expectParity(
      or(
        and(compare('list', 'eq', todo), compare('due', 'is_not_empty')),
        and(compare('list', 'eq', doing), compare('assignee', 'in', [MEMBER])),
      ),
    );
  });

  it('on a negated group', async () => {
    await expectParity(not(or(compare('title', 'contains', 'ship'), compare('due', 'is_empty'))));
  });

  it('on an empty group, which constrains nothing', async () => {
    const matched = await expectParity(and());
    expect(matched).toHaveLength(expectedRows.size);
  });

  it('on an empty list, which matches nothing', async () => {
    const matched = await expectParity(compare('list', 'in', []));
    expect(matched).toHaveLength(0);
  });
});

describe('the filter reaches the database safely', () => {
  it('returns every card when no filter is supplied', async () => {
    const all = await cards.listCards(owner, { boardId });
    expect(all).toHaveLength(expectedRows.size);
  });

  it('refuses a filter naming a field outside the whitelist', async () => {
    /* The compiler throws rather than emitting anything it does not recognize,
       so an unknown field never reaches the database as SQL. Reaching this
       through the service proves the wiring, not just the unit. */
    await expect(
      cards.listCards(owner, {
        boardId,
        filter: compare("title'; DROP TABLE work.cards; --", 'eq', 'x'),
      }),
    ).rejects.toThrow();

    // And the table is still there.
    const all = await cards.listCards(owner, { boardId });
    expect(all).toHaveLength(expectedRows.size);
  });

  it('treats a dangerous value as a parameter, matching nothing', async () => {
    const matched = await cards.listCards(owner, {
      boardId,
      filter: compare('title', 'eq', "'; DROP TABLE work.cards; --"),
    });

    expect(matched).toHaveLength(0);
    expect(await cards.listCards(owner, { boardId })).toHaveLength(expectedRows.size);
  });
});
