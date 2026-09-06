import { z } from 'zod';
import { errors, ProjectIdSchema, unsafeAsId } from '@taskflow/contracts';
import { can } from '@taskflow/policy';
import { listProjects } from '../../work/project.service.js';
import { listBoards } from '../../work/board.service.js';
import { listLists } from '../../work/list.service.js';
import { listLabels } from '../../work/label.service.js';
import { listSprints } from '../../work/sprint.service.js';
import { getCardByReference } from '../../work/card.service.js';
import { listMembers } from '../../tenancy/member.service.js';
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
 *
 * `list_members` and `list_sprints`, added later, close the rest of the same
 * complaint — "still no way to mention a member or sprint" — one prompt
 * naming a person or an existing sprint by name had no more path to an id
 * than a project or label did. `list_members` is the one closing a gap
 * `chat.post_message`'s own section in CLAUDE.md named explicitly and left
 * open ("there is still no tool that resolves a person's NAME to a
 * userId... a mention today needs a userId the conversation already
 * supplied some other way") — this is that tool, and every write tool
 * taking a `userId` (`card_assign`, `card_create`'s own `assigneeIds`,
 * `chat_post_message`'s `mention` segments) can now reach one from a name
 * in the same turn.
 *
 * `find_card` closes the identical gap for the entity people name MOST
 * often — a card, by its reference ("WEB-142") — found from a real
 * transcript where "move WEB-709" had no path to a real `cardId` at all.
 * `search` cannot fill it for the same structural reason it cannot for
 * projects/boards/labels above, but for content rather than entity type: it
 * indexes what a card SAYS, never the reference number every other surface
 * in this app displays it by. See `getCardByReference`'s own header in
 * `work/card.service.ts`.
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

const NoMembersInput = z.object({}).strict();

export function createListMembersTool(): ToolDefinition {
  return defineTool({
    name: 'list_members',
    description:
      'Lists every member of the organization with their id, name, and email — resolve a ' +
      'person the user names or @mentions (e.g. "assign to Priya") to a user id before calling ' +
      'a tool that takes one. If more than one member could match what the user said, ask which ' +
      'one they meant rather than guessing.',
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiresConfirmation: false,
    inputSchema: NoMembersInput,
    async execute(ctx) {
      /* `listMembers` performs no check of its own — its route floors on
         `member:read`, and a tool call bypasses every route, the identical
         reasoning `apps/worker`'s automation executor gives for checking
         `member:manage` itself before a service with no built-in check of
         its own. */
      if (!can(ctx.subject, 'member:read').allowed) {
        throw errors.forbidden('You do not have permission to view organization members.');
      }
      const members = await listMembers(ctx.subject.orgId);
      if (members.length === 0) {
        return { content: 'This organization has no members.' };
      }
      const summarized = members.map((member) => ({
        userId: member.userId,
        name: member.displayName ?? member.email,
        email: member.email,
      }));
      return { content: JSON.stringify(summarized) };
    },
  });
}

const ListSprintsInput = z.object({ projectId: ProjectIdSchema }).strict();

export function createListSprintsTool(): ToolDefinition {
  return defineTool({
    name: 'list_sprints',
    description:
      "Lists a project's sprints (active, planned, and recently closed) with their ids — " +
      'resolve a sprint the user names (e.g. "add it to Sprint 14") to an id before calling ' +
      "`sprint_add_cards` or `card_create`'s own `sprintId`.",
    jsonSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: ListSprintsInput,
    async execute(ctx, input) {
      const sprints = await listSprints(actorOf(ctx), { projectId: input.projectId });
      if (sprints.length === 0) {
        return { content: 'This project has no sprints yet.' };
      }
      const summarized = sprints.map((sprint) => ({
        sprintId: sprint.sprintId,
        name: sprint.name,
        status: sprint.status,
      }));
      return { content: JSON.stringify(summarized) };
    },
  });
}

const FindCardInput = z.object({ reference: z.string().min(1).max(20) }).strict();

/**
 * The lookup gap every other tool in this file already closed for its own
 * entity type, left open for the most commonly referenced entity of all — a
 * CARD. Found from a real transcript: asked to move "WEB-709", the model had
 * no way to reach a real `cardId` from that reference at all. `search` looks
 * like the obvious fallback and is not one — it indexes card CONTENT (title,
 * description text), never the reference itself, so searching "WEB-709"
 * matches nothing; the model fell back to guessing, then to a plain listing
 * of ~50 unfiltered cards, and picked the wrong one. `getCardByReference`
 * (`work/card.service.ts`) is the real fix; this is its tool wrapper.
 */
export function createFindCardTool(): ToolDefinition {
  return defineTool({
    name: 'find_card',
    description:
      'Resolves a card\'s human-readable reference (like "WEB-142") to its real id. Use this ' +
      'whenever the user names a card by its reference rather than giving you an id directly — ' +
      '"move WEB-709", "what\'s the status of API-6". This is the only reliable way to reach a ' +
      "card's id from its reference — `search` indexes card content, never the reference itself.",
    jsonSchema: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description: 'The card\'s reference, e.g. "WEB-142".',
        },
      },
      required: ['reference'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: FindCardInput,
    async execute(ctx, input) {
      const card = await getCardByReference(actorOf(ctx), { reference: input.reference });
      return { content: JSON.stringify(card) };
    },
  });
}
