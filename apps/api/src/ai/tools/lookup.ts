import { z } from 'zod';
import { ProjectIdSchema, unsafeAsId } from '@taskflow/contracts';
import { listProjects } from '../../work/project.service.js';
import { listBoards } from '../../work/board.service.js';
import { listLists } from '../../work/list.service.js';
import { listLabels } from '../../work/label.service.js';
import type { WorkActor } from '../../work/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * Read-only lookup tools — resolving a NAME the user typed ("project X",
 * "tag it y") into the id every write tool actually needs, closing the same
 * gap `card_create`'s own doc comment and `chat_post_message`'s already
 * named without a fix: "there is still no tool that resolves a person's
 * NAME to a userId... a mention today needs a userId the conversation
 * already supplied some other way." Found from a real conversation where a
 * person asked the assistant to "create a card in project X... tag it y"
 * and there was no way for the model to get there without already knowing
 * every id involved — every write tool's own id-typed field, and there was
 * nothing else in the whole registry that could ever produce one.
 *
 * `search` cannot fill this gap either, for the same structural reason
 * `my-cards.ts`'s header documents for assignee/due: `search`'s entity
 * types are `card`/`message`/`page`/`comment`/`transcript` — no `project`,
 * `board`, or `label` at all, because those were never indexed as
 * documents in the first place (Phase 8 built the search index over
 * content people write, not over the vocabulary a project is organized
 * with).
 */

function actorOf(ctx: ToolContext): WorkActor {
  return { subject: ctx.subject, requestId: ctx.requestId };
}

const NoInput = z.object({}).strict();

export function createListProjectsTool(): ToolDefinition {
  return defineTool({
    name: 'list_projects',
    description:
      "Lists every project the current user can access, with each project's id — needed " +
      'before creating or looking up anything by project NAME, since every other tool takes an ' +
      'id, never a name.',
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiresConfirmation: false,
    inputSchema: NoInput,
    async execute(ctx) {
      const projects = await listProjects(actorOf(ctx), { includeArchived: false });
      if (projects.length === 0) {
        return { content: 'No projects exist yet.' };
      }
      const summarized = projects.map((project) => ({
        projectId: project.projectId,
        name: project.name,
        key: project.key,
      }));
      return { content: JSON.stringify(summarized) };
    },
  });
}

const ListBoardsInput = z.object({ projectId: ProjectIdSchema }).strict();

export function createListBoardsTool(): ToolDefinition {
  return defineTool({
    name: 'list_boards',
    description:
      "Lists a project's boards and, nested under each board, its lists (columns) — one call " +
      "instead of two, since a card is always created into a specific LIST. Use the project's " +
      'id from `list_projects`, not its name.',
    jsonSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: ListBoardsInput,
    async execute(ctx, input) {
      const actor = actorOf(ctx);
      const boards = await listBoards(actor, {
        projectId: input.projectId,
        includeArchived: false,
      });
      if (boards.length === 0) {
        return { content: 'This project has no boards.' };
      }

      // A per-project fan-out bounded by board count — small and human-scaled
      // by construction, the same reasoning `search/router.ts`'s per-hit
      // can() loop gives for not being "optimized" into a join.
      const withLists = [];
      for (const board of boards) {
        const lists = await listLists(actor, { boardId: unsafeAsId<'BoardId'>(board.boardId) });
        withLists.push({
          boardId: board.boardId,
          name: board.name,
          lists: lists.map((list) => ({ listId: list.listId, name: list.name })),
        });
      }

      return { content: JSON.stringify(withLists) };
    },
  });
}

const ListLabelsInput = z.object({ projectId: ProjectIdSchema }).strict();

export function createListLabelsTool(): ToolDefinition {
  return defineTool({
    name: 'list_labels',
    description:
      "Lists a project's labels with their ids — use this to resolve a label the user names " +
      '(e.g. "tag it Bug") to the id `card_add_labels` actually needs. If the label the user ' +
      'named is not in this list, tell them it does not exist rather than guessing a close match.',
    jsonSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: ListLabelsInput,
    async execute(ctx, input) {
      const labels = await listLabels(actorOf(ctx), { projectId: input.projectId });
      if (labels.length === 0) {
        return { content: 'This project has no labels defined yet.' };
      }
      const summarized = labels.map((label) => ({ labelId: label.labelId, name: label.name }));
      return { content: JSON.stringify(summarized) };
    },
  });
}
