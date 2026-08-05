import { createEvent } from '@taskflow/events';
import { rankSequence } from '@taskflow/contracts';
import { boardCreated, listCreated } from '@taskflow/api/events/work';
import { LIST_NAMES, WIP_LIMIT, WIP_LIMITED_LIST, type BoardPlan } from '../profiles.js';
import { defineSeedModule } from '../registry.js';
import { daysBefore, envelopeFor, latest } from '../support.js';
import { projectsModule, type SeededProject } from './work.projects.js';

/**
 * Boards and lists.
 *
 * A board with zero lists never happens — every `BoardPlan` names at least one
 * — but a project with zero BOARDS does (`Design System` in the demo profile),
 * and the loop below handles that as the empty case it is: no boards, no
 * ranks to generate, nothing written.
 */

export interface SeededList {
  readonly id: string;
  readonly name: string;
  readonly wipLimit: number | null;
}

export interface SeededBoard {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  /** Carried by reference so `work.cards` and `authz.tuples` reach the
   * project's org, statuses, labels and custom fields without re-requiring
   * `work.projects` themselves. */
  readonly project: SeededProject;
  readonly name: string;
  readonly plan: BoardPlan;
  readonly lists: readonly SeededList[];
  readonly createdAt: Date;
}

export interface BoardsOutput {
  readonly boards: readonly SeededBoard[];
}

export const boardsModule = defineSeedModule({
  name: 'work.boards',
  requires: [projectsModule],
  tables: ['work.boards', 'work.lists'],

  async seed(ctx): Promise<BoardsOutput> {
    const rng = ctx.rng.fork('work.boards');
    const { projects } = ctx.use(projectsModule);
    const boards: SeededBoard[] = [];

    for (const project of projects) {
      const boardRanks = rankSequence(project.plan.boards.length);

      for (const [index, plan] of project.plan.boards.entries()) {
        const boardId = rng.uuid(ctx.now);
        const rank = boardRanks[index];
        if (rank === undefined) {
          throw new Error('rankSequence produced fewer ranks than boards — this is a bug here.');
        }

        const createdAt = latest(project.createdAt, daysBefore(ctx.now, rng.int(5, 220)));
        const creator = rng.pick(project.org.members);
        const envelope = envelopeFor(project.orgId, creator.id, createdAt);

        // `slice` rather than indexing each name: a board's columns are always
        // the FIRST `lists` names, so two boards on one project agree on what
        // "In Progress" means well enough for the WIP limit to land consistently.
        const listNames = LIST_NAMES.slice(0, plan.lists);
        const listRanks = rankSequence(listNames.length);
        const lists: SeededList[] = listNames.map((name) => ({
          id: rng.uuid(ctx.now),
          name,
          wipLimit: name === WIP_LIMITED_LIST ? WIP_LIMIT : null,
        }));

        await ctx.orgScope(project.orgId, async () => {
          await ctx.db.insert(
            'work.boards',
            [
              'id',
              'org_id',
              'project_id',
              'name',
              'rank',
              'archived_at',
              'deleted_at',
              'created_by',
              'created_at',
              'updated_at',
            ],
            [
              [
                boardId,
                project.orgId,
                project.id,
                plan.name,
                rank,
                null,
                null,
                creator.id,
                createdAt,
                createdAt,
              ],
            ],
          );

          if (lists.length > 0) {
            await ctx.db.insert(
              'work.lists',
              [
                'id',
                'org_id',
                'project_id',
                'board_id',
                'name',
                'rank',
                'wip_limit',
                'archived_at',
                'deleted_at',
                'created_at',
                'updated_at',
              ],
              lists.map((list, listIndex) => {
                const listRank = listRanks[listIndex];
                if (listRank === undefined) {
                  throw new Error('rankSequence produced fewer ranks than lists — a bug here.');
                }
                return [
                  list.id,
                  project.orgId,
                  project.id,
                  boardId,
                  list.name,
                  listRank,
                  list.wipLimit,
                  null,
                  null,
                  createdAt,
                  createdAt,
                ];
              }),
            );
          }
        });

        ctx.emit(
          createEvent(boardCreated, { boardId, projectId: project.id, name: plan.name }, envelope),
        );
        for (const list of lists) {
          ctx.emit(
            createEvent(listCreated, { listId: list.id, boardId, name: list.name }, envelope),
          );
        }

        boards.push({
          id: boardId,
          orgId: project.orgId,
          projectId: project.id,
          project,
          name: plan.name,
          plan,
          lists,
          createdAt,
        });
      }

      ctx.log(`work.boards: ${project.key} — ${String(project.plan.boards.length)} boards`);
    }

    return { boards };
  },
});
