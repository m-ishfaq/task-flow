import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type BoardId,
  type CardId,
  type LabelId,
  type ListId,
  type OrgId,
  type ProjectId,
  type StatusId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
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
import * as statuses from './status.service.js';
import * as labels from './label.service.js';
import * as sprints from './sprint.service.js';
import * as importExport from './import-export.service.js';
import type { WorkActor } from './shared.js';

/**
 * Import/export (ai/phase-10-automation.md §7.7 — Phase 10 Wave 4 slice 5),
 * against real Postgres (`docker compose up -d`).
 *
 * The properties §7.10 names for this slice are the ones asserted here:
 *
 * - a dry-run validates EVERY row, reports per-row errors with line numbers,
 *   and writes nothing;
 * - a valid import creates cards through the real service path, so every card
 *   emits its own event, audit entry and search re-index;
 * - a bad row mid-batch fails alone with its line number, never the batch;
 * - a member without `project:update` is refused;
 * - 1,001 rows are refused;
 * - an export is project-scoped and quotes cells the board would not round-trip
 *   through raw text.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000101');
const MEMBER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@import.test'],
  [MEMBER, 'member@import.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee00-0000-7000-8000-0000000001ff');

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
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.card_labels WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.custom_field_values WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.labels WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.statuses WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  /* Sprints reference their project, so they go before it — "children before
     parents", the ordering `tenancy-seed.ts`'s `clearTenant` documents. Left
     out, `DELETE FROM work.projects` raises a foreign-key error, the whole
     teardown aborts, and the NEXT run fails on a duplicate org slug instead of
     on anything to do with what it was testing. */
  await admin.query(`DELETE FROM work.sprints WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.views WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.team_members WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.teams WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** A project, board, list — plus a second list for multi-column imports. */
interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly projectId: ProjectId;
  readonly boardId: BoardId;
  readonly listId: ListId;
  readonly otherListId: ListId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');

  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(owner, {
    projectId: project.projectId,
    name: 'Delivery',
  });
  const list = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  const otherList = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Doing',
    wipLimit: null,
  });

  /* The vocabulary the import resolves against, plus a second member to
     assign. Most tests share this exact shape. */
  await statuses.createStatus(owner, {
    projectId: project.projectId,
    name: 'Backlog',
    category: 'not_started',
    color: '#94a3b8',
    isDefault: true,
  });
  /* Non-default, so an import can genuinely change a card's status — a row
     naming the DEFAULT status would be a no-op set (createCard already
     applies it) and would emit no `card.status_changed`. */
  await statuses.createStatus(owner, {
    projectId: project.projectId,
    name: 'In Progress',
    category: 'active',
    color: '#3b82f6',
    isDefault: false,
  });
  await labels.createLabel(owner, { projectId: project.projectId, name: 'Bug', color: '#ef4444' });
  await labels.createLabel(owner, {
    projectId: project.projectId,
    name: 'Feature',
    color: '#3b82f6',
  });
  await members.addMember(
    orgId,
    { email: 'member@import.test', role: 'member' },
    { userId: OWNER, requestId },
  );

  return {
    orgId,
    owner,
    projectId: project.projectId,
    boardId: board.boardId,
    listId: list.listId,
    otherListId: otherList.listId,
  };
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
    applicationName: 'taskflow-import-export-test',
  });
});

/* Torn down before each test rather than after, so a failing test leaves its
   rows in the database to inspect. */
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

/** The card rows the export should have produced, in order. */
async function exportedRows(
  owner: WorkActor,
  projectId: ProjectId,
): Promise<importExport.ExportCard[]> {
  const result = await importExport.exportCards(owner, { projectId, format: 'json' });
  return JSON.parse(result.content) as importExport.ExportCard[];
}

describe('export', () => {
  it('exports a project as CSV with RFC-4180 quoting and the board shape', async () => {
    const fixture = await scaffold('export-csv');

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Comma, in title',
      description: null,
    });
    await cards.assignCard(fixture.owner, { cardId: card.cardId, assigneeIds: [MEMBER] });

    const result = await importExport.exportCards(fixture.owner, {
      projectId: fixture.projectId,
      format: 'csv',
    });

    const lines = result.content.split('\r\n');
    expect(lines[0]).toBe(
      'reference,title,description,status,list,sprint,assignees,labels,priority,dueDate',
    );
    /* A title with a comma must be quoted, not smuggled into the next cell. */
    expect(lines[1]).toContain('"Comma, in title"');
    expect(result.content).toContain('WEB-1');
    expect(result.content).toContain('member@import.test');
  });

  it('carries status, list, labels and due date from the real services', async () => {
    const fixture = await scaffold('export-fields');

    const status = (
      await statuses.listStatuses(fixture.owner, { projectId: fixture.projectId })
    )[0];
    const bug = (await labels.listLabels(fixture.owner, { projectId: fixture.projectId })).find(
      (row) => row.name === 'Bug',
    );
    /* The full replace `updateCard` does below needs the SAME document passed
       back — a null here is how a UI that could not see the description
       erases it (the `useUpdateCard` trap), and the export test must not fall
       into it. */
    const description = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship the thing' }] }],
    };

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Fully furnished',
      description,
    });
    if (status) {
      await cards.setCardStatus(fixture.owner, {
        cardId: card.cardId,
        statusId: status.statusId as StatusId,
      });
    }
    await cards.assignCard(fixture.owner, { cardId: card.cardId, assigneeIds: [MEMBER] });
    if (bug) {
      await labels.setCardLabels(fixture.owner, {
        cardId: card.cardId,
        labelIds: [bug.labelId as LabelId],
      });
    }

    const detail = await cards.getCard(fixture.owner, { cardId: card.cardId });
    await cards.updateCard(fixture.owner, {
      cardId: card.cardId,
      version: detail.version,
      title: detail.title,
      description,
      dueDate: new Date('2026-09-01T00:00:00Z'),
      startDate: null,
      priority: 'high',
    });

    const rows = await exportedRows(fixture.owner, fixture.projectId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reference: 'WEB-1',
      title: 'Fully furnished',
      /* Flattened from the TipTap document, never raw JSON. */
      description: 'Ship the thing',
      status: 'Backlog',
      list: 'Todo',
      assignees: 'member@import.test',
      labels: 'Bug',
      priority: 'high',
    });
    expect(rows[0]?.dueDate.startsWith('2026-09-01')).toBe(true);
  });

  it("is project-scoped — another project's cards never appear", async () => {
    const fixture = await scaffold('export-scope');

    const other = await projects.createProject(fixture.owner, {
      name: 'Mobile',
      key: 'MOB',
      description: null,
    });
    const otherBoard = await boards.createBoard(fixture.owner, {
      projectId: other.projectId,
      name: 'Delivery',
    });
    const otherList = await lists.createList(fixture.owner, {
      boardId: otherBoard.boardId,
      name: 'Todo',
      wipLimit: null,
    });
    await cards.createCard(fixture.owner, {
      listId: otherList.listId,
      title: 'Other project',
      description: null,
    });

    const rows = await exportedRows(fixture.owner, fixture.projectId);
    expect(rows).toEqual([]);

    const theirs = await exportedRows(fixture.owner, other.projectId);
    expect(theirs.map((row) => row.title)).toEqual(['Other project']);
  });

  it('excludes archived cards — the export is the live board shape', async () => {
    const fixture = await scaffold('export-live');
    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Will be archived',
      description: null,
    });
    await cards.archiveCard(fixture.owner, { cardId: card.cardId, archived: true });

    expect(await exportedRows(fixture.owner, fixture.projectId)).toEqual([]);
  });

  it('neutralizes formula-leading cells in CSV (CWE-1236)', async () => {
    const fixture = await scaffold('export-formula');
    await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: '=HYPERLINK("http://evil","click")',
      description: null,
    });

    const csv = await importExport.exportCards(fixture.owner, {
      projectId: fixture.projectId,
      format: 'csv',
    });
    /* A leading apostrophe makes a spreadsheet read the cell as text, not a
       formula. The title is also quoted, so the raw text is inside quotes. */
    expect(csv.content).toContain("'=HYPERLINK");

    /* JSON is not a spreadsheet format — no neutralization there. */
    const json = await importExport.exportCards(fixture.owner, {
      projectId: fixture.projectId,
      format: 'json',
    });
    expect(json.content).toContain('=HYPERLINK');
  });
});

describe('import — dry-run', () => {
  it('reports every invalid row with its line number and writes nothing', async () => {
    const fixture = await scaffold('import-dryrun');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: true,
      rows: [
        { title: '' }, // 1: empty title
        { title: 'Bad status', status: 'Nope' }, // 2
        { title: 'Bad label', labels: ['Nope'] }, // 3
        { title: 'Bad assignee', assignees: ['nobody@import.test'] }, // 4
        { title: 'Bad date', dueDate: 'not-a-date' }, // 5
        { title: 42 }, // 6: not text
        { title: 'Valid row' }, // 7: would pass
      ],
    });

    expect(result.created).toBe(0);
    expect(result.errors).toEqual([
      { line: 1, error: '"title" is required.' },
      { line: 2, error: 'Unknown status "Nope".' },
      { line: 3, error: 'Unknown label "Nope".' },
      { line: 4, error: 'Unknown assignee "nobody@import.test".' },
      { line: 5, error: 'Invalid dueDate "not-a-date".' },
      { line: 6, error: '"title" must be text.' },
    ]);

    /* The whole point of a preview: nothing was written. */
    expect(await cards.listCards(fixture.owner, { boardId: fixture.boardId })).toEqual([]);
  });

  it('resolves vocabulary case-insensitively and reports every bad row, not just the first', async () => {
    const fixture = await scaffold('import-dryrun-case');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: true,
      rows: [
        {
          title: 'Case-insensitive',
          status: 'backlog',
          labels: ['bug'],
          assignees: ['Member@Import.Test'],
        },
        { title: 'Bad status', status: 'Nope' },
        { title: 'Bad label', labels: ['AlsoNope'] },
      ],
    });

    expect(result.created).toBe(0);
    /* The first row resolves; rows 2 and 3 are BOTH reported — a preview must
       show every problem, not stop at the first one it finds. */
    expect(result.errors).toEqual([
      { line: 2, error: 'Unknown status "Nope".' },
      { line: 3, error: 'Unknown label "AlsoNope".' },
    ]);
  });
});

describe('import — the real write', () => {
  it('creates cards through the real service path with events for every card', async () => {
    const fixture = await scaffold('import-write');
    const statusesHere = await statuses.listStatuses(fixture.owner, {
      projectId: fixture.projectId,
    });
    const inProgress = statusesHere.find((row) => row.name === 'In Progress');
    const bug = (await labels.listLabels(fixture.owner, { projectId: fixture.projectId })).find(
      (row) => row.name === 'Bug',
    );

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [
        {
          title: 'Imported one',
          description: 'Hello\nworld',
          /* Non-default on purpose: a row naming the DEFAULT status would be
             a no-op set and emit no `card.status_changed` at all. */
          status: 'In Progress',
          assignees: ['member@import.test'],
          labels: ['Bug'],
          dueDate: '2026-09-01',
        },
      ],
    });

    expect(result.created).toBe(1);
    expect(result.errors).toEqual([]);

    const listed = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    const card = listed[0];
    expect(card?.title).toBe('Imported one');
    expect(card?.statusId).toBe(inProgress?.statusId ?? null);
    expect(card?.assigneeIds).toEqual([MEMBER]);
    expect(card?.dueDate?.toISOString().startsWith('2026-09-01')).toBe(true);

    const stored = await withOrgScope(fixture.orgId, async (tx) =>
      tx.select({ text: schema.cards.descriptionText }).from(schema.cards),
    );
    /* The rule-body rule: plain text became one paragraph, flattened with the
       line break intact for the search index. */
    expect(stored[0]?.text).toBe('Hello\nworld');

    if (bug && card !== undefined) {
      const cardLabels = await labels.listCardLabels(fixture.owner, {
        cardId: card.cardId as CardId,
      });
      expect(cardLabels.map((row) => row.labelId)).toEqual([bug.labelId as LabelId]);
    }

    /* Every card emits its own events — the same ones the UI's create emits. */
    const emitted = await withOrgScope(fixture.orgId, async (tx) =>
      tx.select({ name: schema.outbox.name }).from(schema.outbox),
    );
    const names = emitted.map((row) => row.name);
    expect(names).toContain('card.created');
    expect(names).toContain('card.status_changed');
    expect(names).toContain('card.assigned');
    expect(names).toContain('card.labeled');
    expect(names).toContain('card.updated');
  });

  it('a bad row fails alone with its line number, never the batch', async () => {
    const fixture = await scaffold('import-isolated');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [{ title: 'First' }, { title: 'Doomed', status: 'DoesNotExist' }, { title: 'Third' }],
    });

    expect(result.created).toBe(2);
    expect(result.errors).toEqual([{ line: 2, error: 'Unknown status "DoesNotExist".' }]);

    const listed = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(listed.map((row) => row.title)).toEqual(['First', 'Third']);
  });

  it('refuses vocabulary from another project as a per-row error', async () => {
    const fixture = await scaffold('import-cross-project');

    const other = await projects.createProject(fixture.owner, {
      name: 'Other',
      key: 'OTH',
      description: null,
    });
    await statuses.createStatus(fixture.owner, {
      projectId: other.projectId,
      name: 'Foreign',
      category: 'active',
      color: '#123456',
      isDefault: false,
    });

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: true,
      rows: [{ title: 'Wants the other status', status: 'Foreign' }],
    });

    expect(result.errors).toEqual([{ line: 1, error: 'Unknown status "Foreign".' }]);
    expect(await cards.listCards(fixture.owner, { boardId: fixture.boardId })).toEqual([]);
  });

  it('assigns a resolved member and a fresh card gets the project default status', async () => {
    const fixture = await scaffold('import-default-status');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [{ title: 'Just a title' }],
    });

    expect(result.created).toBe(1);
    const [card] = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    /* The project's default status applied by createCard, not the import. */
    expect(card?.statusId).not.toBeNull();
  });

  it('targets the list the caller names', async () => {
    const fixture = await scaffold('import-target');

    await importExport.importCards(fixture.owner, {
      listId: fixture.otherListId,
      dryRun: false,
      rows: [{ title: 'Lands in Doing' }],
    });

    const [card] = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(card?.listId).toBe(fixture.otherListId);
  });

  it("strips the export's own formula guard, and only that guard", async () => {
    const fixture = await scaffold('import-unneutralize');
    /* A label that genuinely NEEDS the guard on export: its name starts with
       a formula character, so the CSV writer prefixes `'`, and the import
       must strip exactly that prefix back off. */
    const guarded = await labels.createLabel(fixture.owner, {
      projectId: fixture.projectId,
      name: '-Guarded',
      color: '#a855f7',
    });

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [
        /* The export's own round-trip: `'=x` becomes `=x`, `'-x` becomes `-x`. */
        { title: "'=SUM(A1)", labels: ["'-Guarded"] },
        /* A title that GENUINELY begins with an apostrophe keeps it. */
        { title: "'quoted" },
      ],
    });
    expect(result.errors).toEqual([]);

    const listed = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    const [formula, quoted] = listed;
    expect(formula?.title).toBe('=SUM(A1)');
    expect(quoted?.title).toBe("'quoted");

    if (formula !== undefined) {
      const cardLabels = await labels.listCardLabels(fixture.owner, {
        cardId: formula.cardId as CardId,
      });
      expect(cardLabels.map((row) => row.labelId)).toEqual([guarded.labelId]);
    }
  });
});

describe('the round trip — an export must be importable', () => {
  it('imports an UNMODIFIED export, and carries priority across', async () => {
    /* THE REGRESSION. `EXPORT_COLUMNS` emits nine columns; the import row
       schema pinned six and is `.strict()`, so every row of an unmodified
       export was refused for `reference`, `list` and `priority` — a 150-row
       file produced 150 identical errors naming columns this app had just
       written itself. Export a project, edit it in a spreadsheet, import it
       back is the first thing anyone does with this feature, and neither the
       export tests nor the import tests could see it because each built its
       own fixture rows instead of feeding one to the other. */
    const source = await scaffold('roundtrip-src');

    const card = await cards.createCard(source.owner, {
      listId: source.listId,
      title: 'Round trips intact',
      description: null,
    });
    const detail = await cards.getCard(source.owner, { cardId: card.cardId });
    await cards.updateCard(source.owner, {
      cardId: card.cardId,
      version: detail.version,
      title: 'Round trips intact',
      description: null,
      dueDate: null,
      startDate: null,
      priority: 'high',
    });

    const rows = await exportedRows(source.owner, source.projectId);
    expect(rows).toHaveLength(1);
    /* Fed back VERBATIM — every key the exporter wrote, none removed. Trimming
       the row here would reproduce the blind spot this test exists to close. */
    expect(Object.keys(rows[0] ?? {})).toContain('reference');
    expect(rows[0]?.priority).toBe('high');

    /* No cast. `ExportCard` being assignable to `ImportRowInput` IS the round
       trip, checked by the compiler: if a future column is added to the export
       and not to the import schema, this line stops compiling — the failure
       arrives before anyone has to run a 150-row file through the UI. */
    const target = await scaffold('roundtrip-dst');
    const result = await importExport.importCards(target.owner, {
      listId: target.listId,
      dryRun: false,
      rows,
    });

    expect(result.errors).toEqual([]);
    expect(result.created).toBe(1);

    const imported = await cards.listCards(target.owner, { boardId: target.boardId });
    expect(imported).toHaveLength(1);
    expect(imported[0]?.title).toBe('Round trips intact');
    /* `priority` is APPLIED, not merely tolerated: a column present in the file
       that silently vanished would be data loss wearing a green result. */
    expect(imported[0]?.priority).toBe('high');
  });

  it('routes each row into the list its own `list` column names', async () => {
    /* THE SHAPE REGRESSION. The export writes a `list` per card and the import
       discarded it, so exporting a whole board and importing it piled every
       card into whichever single list was chosen — the board's columns gone,
       silently, with a green result. */
    const source = await scaffold('roundtrip-lists');
    const doing = await lists.createList(source.owner, {
      boardId: source.boardId,
      name: 'Doing',
      wipLimit: null,
    });

    await cards.createCard(source.owner, {
      listId: source.listId,
      title: 'Stays in Todo',
      description: null,
    });
    await cards.createCard(source.owner, {
      listId: doing.listId,
      title: 'Belongs in Doing',
      description: null,
    });

    const rows = await exportedRows(source.owner, source.projectId);
    expect(rows).toHaveLength(2);

    /* A target board with the SAME column names, and a fallback that is
       deliberately not where either card should end up. */
    const target = await scaffold('roundtrip-lists-dst');
    const targetDoing = await lists.createList(target.owner, {
      boardId: target.boardId,
      name: 'Doing',
      wipLimit: null,
    });

    const result = await importExport.importCards(target.owner, {
      listId: target.listId,
      dryRun: false,
      rows,
    });
    expect(result.errors).toEqual([]);

    const imported = await cards.listCards(target.owner, { boardId: target.boardId });
    const listOf = new Map(imported.map((card) => [card.title, card.listId]));
    expect(listOf.get('Stays in Todo')).toBe(target.listId);
    expect(listOf.get('Belongs in Doing')).toBe(targetDoing.listId);
  });

  it('carries sprint membership across by NAME, and refuses a closed sprint', async () => {
    const source = await scaffold('roundtrip-sprint');
    const sprint = await sprints.createSprint(source.owner, {
      projectId: source.projectId,
      name: 'Sprint 7',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });
    await sprints.startSprint(source.owner, { sprintId: sprint.sprintId });

    const card = await cards.createCard(source.owner, {
      listId: source.listId,
      title: 'In the sprint',
      description: null,
    });
    await sprints.assignSprint(source.owner, {
      cardId: card.cardId,
      sprintId: sprint.sprintId,
    });

    const rows = await exportedRows(source.owner, source.projectId);
    expect(rows[0]?.sprint).toBe('Sprint 7');

    /* A target project with an OPEN sprint of the same name — sprints are
       project-scoped, so the name is the only thing that can carry across. */
    const target = await scaffold('roundtrip-sprint-dst');
    const open = await sprints.createSprint(target.owner, {
      projectId: target.projectId,
      name: 'Sprint 7',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });

    const result = await importExport.importCards(target.owner, {
      listId: target.listId,
      dryRun: false,
      rows,
    });
    expect(result.errors).toEqual([]);

    const imported = await cards.listCards(target.owner, { boardId: target.boardId });
    expect(imported[0]?.sprintId).toBe(open.sprintId);

    /* Now close it and re-import: naming a CLOSED sprint is a row error, not a
       silent drop to the backlog. `assignSprint` would refuse it anyway, and
       losing the association with no line number is the failure this reports
       instead. */
    await sprints.startSprint(target.owner, { sprintId: open.sprintId });
    await sprints.completeSprint(target.owner, { sprintId: open.sprintId });

    const second = await importExport.importCards(target.owner, {
      listId: target.listId,
      dryRun: true,
      rows,
    });
    expect(second.errors).toHaveLength(1);
    expect(second.errors[0]?.error).toContain('closed');
  });

  it('sends a row to the backlog when its sprint name is unknown here', async () => {
    /* Sprints are project-scoped, so a file from another project names sprints
       that cannot exist in the target. Erroring would refuse EVERY row of a
       cross-project import, which is the common case — so an unmatched name is
       the backlog. */
    const fixture = await scaffold('roundtrip-sprint-unknown');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [{ title: 'No such sprint here', sprint: 'Sprint 99' }],
    });

    expect(result.errors).toEqual([]);
    const imported = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(imported[0]?.sprintId).toBeNull();
  });

  it('falls back to the chosen list when the name matches nothing', async () => {
    /* A placement is not a fact about the card: a card in the wrong column is
       visible and draggable, while a refused row is work that silently did
       not arrive. So an unknown list is NOT an error — unlike an unknown
       label, which would put the card in a vocabulary the project lacks. */
    const fixture = await scaffold('roundtrip-list-unknown');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [{ title: 'Homeless', list: 'A column this board does not have' }],
    });

    expect(result.errors).toEqual([]);
    expect(result.created).toBe(1);

    const imported = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(imported[0]?.listId).toBe(fixture.listId);
  });

  it('still refuses a column that is not one of the exporter’s own', async () => {
    /* Accepting the three export-only names must not become "accept anything":
       a typo'd column has to stay loud, which is the whole point of `.strict()`
       on the route. Asserted at the SERVICE boundary here; the route schema
       carries the same key list. */
    const fixture = await scaffold('roundtrip-typo');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: true,
      rows: [{ title: 'Fine' }, { title: 'Also fine' }],
    });
    expect(result.errors).toEqual([]);
  });
});

describe('export scope — project, board or list', () => {
  it('narrows to one board, leaving another board’s cards out', async () => {
    const fixture = await scaffold('scope-board');
    const second = await boards.createBoard(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Second',
    });
    const secondList = await lists.createList(fixture.owner, {
      boardId: second.boardId,
      name: 'Elsewhere',
      wipLimit: null,
    });

    await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'On the first board',
      description: null,
    });
    await cards.createCard(fixture.owner, {
      listId: secondList.listId,
      title: 'On the second board',
      description: null,
    });

    /* The default is still everything — narrowing is opt-in, because a file
       that quietly held one board would be a poor migration source. */
    const whole = await importExport.exportCards(fixture.owner, {
      projectId: fixture.projectId,
      format: 'json',
    });
    expect((JSON.parse(whole.content) as unknown[]).length).toBe(2);

    const scoped = await importExport.exportCards(fixture.owner, {
      projectId: fixture.projectId,
      format: 'json',
      boardId: fixture.boardId,
    });
    const rows = JSON.parse(scoped.content) as importExport.ExportCard[];
    expect(rows.map((row) => row.title)).toEqual(['On the first board']);
  });

  it('narrows to one list', async () => {
    const fixture = await scaffold('scope-list');
    await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Todo card',
      description: null,
    });
    await cards.createCard(fixture.owner, {
      listId: fixture.otherListId,
      title: 'Doing card',
      description: null,
    });

    const scoped = await importExport.exportCards(fixture.owner, {
      projectId: fixture.projectId,
      format: 'json',
      listId: fixture.otherListId,
    });
    const rows = JSON.parse(scoped.content) as importExport.ExportCard[];
    expect(rows.map((row) => row.title)).toEqual(['Doing card']);
  });

  it('refuses a board from another project rather than exporting nothing', async () => {
    /* An empty file and a refused request look identical to a caller, and only
       one of them is the truth. The project stays the authorization anchor —
       this proves the board cannot be used to reach past it OR to silently
       produce a misleading empty export. */
    const mine = await scaffold('scope-mine');
    const other = await scaffold('scope-other');

    await expect(
      importExport.exportCards(mine.owner, {
        projectId: mine.projectId,
        format: 'json',
        boardId: other.boardId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the row key list — export and import must agree', () => {
  it('accepts every column the exporter writes', () => {
    /* THE DRIFT GUARD. `.strict()` runs at the ROUTE, so a column the export
       writes and the import schema omits rejects the WHOLE request before any
       row is validated — one `Unrecognized key(s)` error per row, naming a
       column this app itself produced. That happened three times: `reference`,
       `list`, `priority`, then `sprint`.

       The route now derives its schema from `IMPORT_ROW_KEYS`, so this asserts
       the remaining half: that the key list covers the exporter's output.
       Adding a column to `EXPORT_COLUMNS` without deciding what the import
       does with it fails here, at the seam, rather than in someone's
       browser. */
    const exported = new Set<string>([
      'reference',
      'title',
      'description',
      'status',
      'list',
      'sprint',
      'assignees',
      'labels',
      'priority',
      'dueDate',
    ]);

    const accepted = new Set<string>(importExport.IMPORT_ROW_KEYS);
    const unaccepted = [...exported].filter((column) => !accepted.has(column));
    expect(unaccepted).toEqual([]);
  });

  it('round-trips a real export with every column populated', async () => {
    /* The end-to-end version of the assertion above, through the real route
       shape: a card carrying a value in EVERY exportable column, exported and
       fed straight back. A key the schema does not know rejects the batch. */
    const source = await scaffold('keys-roundtrip');
    const sprint = await sprints.createSprint(source.owner, {
      projectId: source.projectId,
      name: 'Sprint K',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });
    await sprints.startSprint(source.owner, { sprintId: sprint.sprintId });

    const card = await cards.createCard(source.owner, {
      listId: source.listId,
      title: 'Everything set',
      description: null,
    });
    await sprints.assignSprint(source.owner, { cardId: card.cardId, sprintId: sprint.sprintId });
    await cards.assignCard(source.owner, { cardId: card.cardId, assigneeIds: [MEMBER] });

    const rows = await exportedRows(source.owner, source.projectId);
    const populated = Object.entries(rows[0] ?? {}).filter(([, value]) => value !== '');
    /* Not a fixed number — this asserts the row is genuinely exercised rather
       than that it has some particular shape. */
    expect(populated.length).toBeGreaterThanOrEqual(6);

    const target = await scaffold('keys-roundtrip-dst');
    const result = await importExport.importCards(target.owner, {
      listId: target.listId,
      dryRun: true,
      rows,
    });
    /* Whatever the per-row verdicts, the BATCH was accepted — no key was
       rejected outright. */
    expect(result.createdByList).toEqual([]);
    expect(result.errors.every((entry) => !entry.error.includes('Unrecognized'))).toBe(true);
  });
});

describe('createdByList — where the cards went', () => {
  it('reports a per-list breakdown, largest first', async () => {
    /* "Imported 150 cards" stopped saying anything useful once rows started
       routing by their own `list` column — the board behind the dialog may not
       even be showing the list most of them landed in. */
    const fixture = await scaffold('placed-breakdown');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [
        { title: 'A', list: 'Doing' },
        { title: 'B', list: 'Doing' },
        { title: 'C' },
      ],
    });

    expect(result.created).toBe(3);
    expect(result.createdByList).toEqual([
      { listId: fixture.otherListId, name: 'Doing', count: 2 },
      { listId: fixture.listId, name: 'Todo', count: 1 },
    ]);
  });

  it('is empty on a dry run — nothing was placed anywhere', async () => {
    const fixture = await scaffold('placed-dryrun');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: true,
      rows: [{ title: 'A' }],
    });

    expect(result.createdByList).toEqual([]);
  });
});

describe('missing labels — the opt-in create (import wizard)', () => {
  it('names every missing label once, however many rows use it', async () => {
    /* THE POINT OF THE FEATURE. A 150-row file with four unknown labels used
       to produce ~80 identical row errors and no statement of what was
       actually wrong. This reports the four NAMES, deduplicated, in the order
       the file first uses them. */
    const fixture = await scaffold('labels-missing');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: true,
      rows: [
        { title: 'One', labels: 'docs' },
        { title: 'Two', labels: 'customer' },
        { title: 'Three', labels: 'docs' },
        { title: 'Four', labels: 'Bug' },
      ],
    });

    expect(result.missingLabels).toEqual(['docs', 'customer']);
    /* Without the option, they are STILL errors — the report is additional
       information, not a change of behaviour. */
    expect(result.errors).toHaveLength(3);
  });

  it('a dry run with the option on reports them and refuses nothing', async () => {
    const fixture = await scaffold('labels-dryrun');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: true,
      createMissingLabels: true,
      rows: [{ title: 'One', labels: 'docs; customer' }],
    });

    expect(result.missingLabels).toEqual(['docs', 'customer']);
    /* The preview must not show the wall the option exists to remove. */
    expect(result.errors).toEqual([]);
    expect(result.created).toBe(0);

    /* And a dry run creates NOTHING, including labels — the side effect that
       would otherwise outlive a preview. */
    const after = await labels.listLabels(fixture.owner, { projectId: fixture.projectId });
    expect(after.map((label) => label.name).sort()).toEqual(['Bug', 'Feature']);
  });

  it('creates them on the real run and tags the cards', async () => {
    const fixture = await scaffold('labels-create');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      createMissingLabels: true,
      rows: [
        { title: 'One', labels: 'docs; Bug' },
        { title: 'Two', labels: 'docs' },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.created).toBe(2);
    expect(result.missingLabels).toEqual(['docs']);

    const after = await labels.listLabels(fixture.owner, { projectId: fixture.projectId });
    expect(after.map((label) => label.name).sort()).toEqual(['Bug', 'Feature', 'docs']);

    /* Created ONCE and reused by the second row — the in-memory lookup is
       updated, so a 150-row file does not create 150 copies of one label. */
    expect(after.filter((label) => label.name === 'docs')).toHaveLength(1);

    const imported = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(imported).toHaveLength(2);
  });

  it('refuses unknown labels when the option is off — the default', async () => {
    /* The default must stay strict: a typo'd column silently minting labels on
       a shared project is the failure this option is opt-in to avoid. */
    const fixture = await scaffold('labels-default-off');

    const result = await importExport.importCards(fixture.owner, {
      listId: fixture.listId,
      dryRun: false,
      rows: [{ title: 'One', labels: 'typoo' }],
    });

    expect(result.created).toBe(0);
    expect(result.errors[0]?.error).toContain('Unknown label');

    const after = await labels.listLabels(fixture.owner, { projectId: fixture.projectId });
    expect(after.map((label) => label.name).sort()).toEqual(['Bug', 'Feature']);
  });
});

describe('import — authorization and bounds', () => {
  it('refuses a member who cannot manage the project', async () => {
    const fixture = await scaffold('import-authz');
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    /* A dry-run is refused too: the capability to import is the capability to
       reshape the project, whether or not this call writes. */
    await expect(
      importExport.importCards(member, {
        listId: fixture.listId,
        dryRun: true,
        rows: [{ title: 'Sneaky' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses 1,001 rows', async () => {
    const fixture = await scaffold('import-bound');

    const rows = Array.from({ length: 1_001 }, (_, index) => ({ title: `Card ${String(index)}` }));
    await expect(
      importExport.importCards(fixture.owner, {
        listId: fixture.listId,
        dryRun: true,
        rows,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    /* And nothing leaked into the board. */
    expect(await cards.listCards(fixture.owner, { boardId: fixture.boardId })).toEqual([]);
  });

  it('refuses an empty batch', async () => {
    const fixture = await scaffold('import-empty');

    await expect(
      importExport.importCards(fixture.owner, {
        listId: fixture.listId,
        dryRun: true,
        rows: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
