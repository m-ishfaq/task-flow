import { createEvent } from '@taskflow/events';
import { viewCreated } from '@taskflow/api/events/work';
import { roleGrants } from '@taskflow/policy';
import { ME, type FilterNode } from '@taskflow/filter';
import { defineSeedModule } from '../registry.js';
import { daysAfter, daysBefore, envelopeFor, latest } from '../support.js';
import { boardsModule, type SeededBoard } from './work.boards.js';

/**
 * Saved views — a named, stored arrangement of one board (migration 0014).
 *
 * ## The filter is the reason this module is worth having
 *
 * A view row is four fields and a name; what makes it interesting is the
 * `filter` column, which holds a `FilterNode` tree that both backends of
 * `packages/filter` have to agree about. CLAUDE.md records that the `label`
 * field was wrong in BOTH of them at once — a 500 from the compiler and a silent
 * no-match from the evaluator — and that it had no test. The templates below
 * deliberately include the shapes that have historically been wrong, so a seeded
 * database is a standing exercise of them rather than a pile of unfiltered
 * boards:
 *
 *   * `label in [...]` and `not(label in [...])` — the `uuid_array` field. A
 *     bare NOT is UNKNOWN for a card with no labels, so Postgres drops exactly
 *     the rows a user expects to see; the compiler's COALESCE is what keeps
 *     them, and nothing else in the seed makes it run.
 *   * `label is_empty` — the NULL `array_agg` returns for an unlabelled card.
 *   * `due lt <iso>` and `due is_empty` — SQL's three-valued logic, where a null
 *     due date matches neither a comparison nor its negation.
 *   * `archived eq false` — the computed boolean, not the timestamp column.
 *   * an `or` group and a nested `and` — so the tree walk has depth to walk.
 *
 * ## `@me` is stored as `@me`
 *
 * The single most valuable row here is a SHARED view filtered on
 * `assignee in ['@me']`. The whole reason §10.2 keeps `@me` symbolic until
 * compile time is that a client substituting its own id would turn a shared
 * "assigned to me" view into "assigned to whoever saved it" — silently, and
 * only for everybody else. Seeding the literal `ME` constant means the stored
 * tree is the thing the compiler has to resolve per caller.
 *
 * ## Who may author what
 *
 * A SHARED view is part of the board, so creating one is `board:update` — which
 * `member` does not hold. A PRIVATE view needs only `board:read`. Both are asked
 * through `roleGrants` rather than compared inline (guardrail 7), and the split
 * matters for the fixture: a shared view authored by a plain member is a row no
 * route could have produced.
 *
 * ## `visible_columns` is null everywhere, deliberately
 *
 * The column exists and the service round-trips it, but the client has no column
 * vocabulary yet — `table-view.tsx` renders a fixed set and `view-tabs.tsx`
 * writes `null` on every save. Seeding an array of invented ids would be a
 * fixture asserting a contract that does not exist, and the migration already
 * says NULL means "whatever the table defaults to". When column selection ships,
 * this is the line that changes.
 */

export interface ViewsOutput {
  readonly viewCount: number;
}

/** Builds a template's filter from the ids this board actually has. */
interface FilterContext {
  readonly labelIds: readonly string[];
  readonly listIds: readonly string[];
  readonly overdueBefore: string;
  readonly quarterEnd: string;
}

interface ViewTemplate {
  readonly name: string;
  readonly type: 'board' | 'table' | 'list';
  readonly groupBy: 'list' | 'status' | 'assignee' | 'priority' | 'due' | null;
  readonly sortBy: 'manual' | 'title' | 'due' | 'priority' | null;
  /** Null means an unfiltered view — a saved ARRANGEMENT, which is a real thing
   * to save and which the migration is explicit must not look accidental. */
  readonly filter: ((context: FilterContext) => FilterNode | null) | null;
  /**
   * Private views are personal bookmarks: author-only to read and to edit, with
   * no permission override. Each private template is instantiated once PER
   * AUTHOR, which is what produces two people holding a same-named view on one
   * board — the case `views_board_private_name_key` exists for.
   */
  readonly shared: boolean;
}

/**
 * The templates, ORDERED. A board takes the first `views` of them.
 *
 * Order is the whole design: the early entries are what any board should have,
 * and the later ones are the states that are hard to reach by accident. A board
 * asking for nine gets all of them; a board asking for two gets a sensible pair.
 * Same arrangement as `LIST_NAMES` and `lists`.
 */
const VIEW_TEMPLATES: readonly ViewTemplate[] = [
  {
    name: 'All work',
    type: 'board',
    groupBy: 'list',
    sortBy: 'manual',
    filter: null,
    shared: true,
  },
  {
    /* The `@me` view, and it is SHARED on purpose — see the module header. */
    name: 'My open tasks',
    type: 'list',
    groupBy: 'status',
    sortBy: 'due',
    filter: () => ({
      kind: 'group',
      combinator: 'and',
      children: [
        { kind: 'comparison', field: 'assignee', operator: 'in', value: [ME] },
        { kind: 'comparison', field: 'archived', operator: 'eq', value: false },
      ],
    }),
    shared: true,
  },
  {
    name: 'Overdue',
    type: 'table',
    groupBy: null,
    sortBy: 'due',
    filter: (context) => ({
      kind: 'group',
      combinator: 'and',
      children: [
        { kind: 'comparison', field: 'due', operator: 'lt', value: context.overdueBefore },
        { kind: 'comparison', field: 'archived', operator: 'eq', value: false },
      ],
    }),
    shared: true,
  },
  {
    name: 'Urgent and high',
    type: 'board',
    groupBy: 'assignee',
    sortBy: 'priority',
    filter: () => ({
      kind: 'comparison',
      field: 'priority',
      operator: 'in',
      value: ['urgent', 'high'],
    }),
    shared: true,
  },
  {
    /* `is_empty` on a `uuid_array` — the NULL `array_agg` returns for a card
       with no labels at all, which is a different thing from an empty array. */
    name: 'Needs triage',
    type: 'list',
    groupBy: 'list',
    sortBy: 'title',
    filter: () => ({ kind: 'comparison', field: 'label', operator: 'is_empty' }),
    shared: true,
  },
  {
    /* The negated label filter. A bare `NOT (labels && ...)` is UNKNOWN for an
       unlabelled card, so Postgres would drop precisely the rows the name of
       this view promises. Nothing else in the seeded database makes that path
       run. */
    name: 'Excluding the first two labels',
    type: 'board',
    groupBy: 'status',
    sortBy: 'manual',
    filter: (context) =>
      context.labelIds.length === 0
        ? null
        : {
            kind: 'not',
            child: {
              kind: 'comparison',
              field: 'label',
              operator: 'in',
              value: [...context.labelIds],
            },
          },
    shared: true,
  },
  {
    /* First PRIVATE template — instantiated once per author, so a board
       reaching it ends up with two people each holding "My stuff". */
    name: 'My stuff',
    type: 'table',
    groupBy: null,
    sortBy: 'manual',
    filter: () => ({ kind: 'comparison', field: 'creator', operator: 'eq', value: ME }),
    shared: false,
  },
  {
    name: 'No due date',
    type: 'list',
    groupBy: 'priority',
    sortBy: 'priority',
    filter: () => ({ kind: 'comparison', field: 'due', operator: 'is_empty' }),
    shared: true,
  },
  {
    /* Named "Overdue" on purpose, matching the SHARED template above. The two
       partial unique indexes are separate, so a private view may carry a name a
       shared one already uses — and a board that has both is the only way to
       see that the tab strip keeps them apart. */
    name: 'Overdue',
    type: 'board',
    groupBy: 'status',
    sortBy: 'manual',
    filter: (context) => ({
      kind: 'group',
      combinator: 'or',
      children: [
        { kind: 'comparison', field: 'priority', operator: 'in', value: ['urgent'] },
        { kind: 'comparison', field: 'due', operator: 'lt', value: context.quarterEnd },
      ],
    }),
    shared: false,
  },
];

/** How many authors a private template is instantiated for. */
const PRIVATE_AUTHORS = 2;

export const viewsModule = defineSeedModule({
  name: 'work.views',
  requires: [boardsModule],
  tables: ['work.views'],

  async seed(ctx): Promise<ViewsOutput> {
    const rng = ctx.rng.fork('work.views');
    const { boards } = ctx.use(boardsModule);

    const byOrg = new Map<string, SeededBoard[]>();
    for (const board of boards) {
      if ((board.plan.views ?? 0) === 0) continue;
      const list = byOrg.get(board.orgId) ?? [];
      list.push(board);
      byOrg.set(board.orgId, list);
    }

    let viewCount = 0;

    for (const [orgId, orgBoards] of byOrg) {
      const rows: unknown[][] = [];

      for (const board of orgBoards) {
        const project = board.project;
        const templates = VIEW_TEMPLATES.slice(0, board.plan.views ?? 0);

        /* A shared view is `board:update`, which `member` does not hold; a
           private one needs only `board:read`, which excludes guests. Asked as
           capabilities so the matrix test is the thing that decides. */
        const sharers = project.org.memberships.filter((membership) =>
          roleGrants(membership.role, 'board:update'),
        );
        const readers = project.org.memberships.filter((membership) =>
          roleGrants(membership.role, 'board:read'),
        );

        const context: FilterContext = {
          // Two ids, so `not(label in [...])` is a genuine list rather than a
          // one-element one that a reader could mistake for `neq`.
          labelIds: project.labels.slice(0, 2).map((label) => label.id),
          listIds: board.lists.map((list) => list.id),
          overdueBefore: ctx.now.toISOString(),
          quarterEnd: daysAfter(ctx.now, 90).toISOString(),
        };

        let position = 0;

        for (const template of templates) {
          const authors = template.shared
            ? sharers.slice(0, 1)
            : rng.sample(readers, Math.min(PRIVATE_AUTHORS, readers.length));

          if (authors.length === 0) {
            /* No one in this org could have authored it. Skipped rather than
               attributed to somebody who lacks the permission — a shared view
               created by a plain member is a row no route could write, and a
               fixture that contains one teaches the wrong thing. */
            continue;
          }

          for (const author of authors) {
            const createdAt = latest(board.createdAt, daysBefore(ctx.now, rng.int(1, 120)));
            const viewId = rng.uuid(createdAt);
            const filter = template.filter === null ? null : template.filter(context);

            rows.push([
              viewId,
              board.orgId,
              board.projectId,
              board.id,
              template.name,
              template.type,
              template.groupBy,
              template.sortBy,
              filter,
              // See the module header: null, not an invented column list.
              null,
              template.shared,
              author.user.id,
              position,
              createdAt,
              createdAt,
            ]);

            /* Always emitted, never sampled: a view is structural and
               low-volume, and "who added the tab everyone sees" is a question
               an audit reader asks. The filter tree is deliberately absent from
               the payload — it is unbounded, and an outbox row is replayed into
               a log that keeps whatever is put in it. */
            ctx.emit(
              createEvent(
                viewCreated,
                {
                  viewId,
                  boardId: board.id,
                  name: template.name,
                  type: template.type,
                  shared: template.shared,
                },
                envelopeFor(board.orgId, author.user.id, createdAt),
              ),
            );

            position += 1;
            viewCount += 1;
          }
        }
      }

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'work.views',
          [
            'id',
            'org_id',
            'project_id',
            'board_id',
            'name',
            'type',
            'group_by',
            'sort_by',
            'filter::jsonb',
            'visible_columns::jsonb',
            'is_shared',
            'created_by',
            'position',
            'created_at',
            'updated_at',
          ],
          rows,
        );
      });

      ctx.log(`work.views: ${String(rows.length)} saved views`);
    }

    return { viewCount };
  },
});

/**
 * Every template's filter, built against a representative context.
 *
 * Exported for the test, which runs each one through `validate('card', node)` —
 * the SAME function `view.service.ts` calls on write and on read. A stored tree
 * that fails it is not a cosmetic problem: the service reports the view as
 * `filterBroken`, so the board silently falls back to unfiltered and the tab
 * looks like it works.
 */
export function templateFilters(context: FilterContext): readonly (FilterNode | null)[] {
  return VIEW_TEMPLATES.map((template) =>
    template.filter === null ? null : template.filter(context),
  );
}

export { VIEW_TEMPLATES, type FilterContext, type ViewTemplate };
