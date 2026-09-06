import { z } from 'zod';
import {
  CardIdSchema,
  ListIdSchema,
  Priority,
  StatusIdSchema,
  unsafeAsId,
  UserIdSchema,
  type UserId,
} from '@taskflow/contracts';
import {
  assignCard,
  createCard,
  getCard,
  updateCard,
  setCardStatus,
} from '../../work/card.service.js';
import { plainParagraph, RichTextDocument, type RichTextNode } from '../../work/richtext.js';
import type { WorkActor } from '../../work/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * The single-card write tools (§4.1's table: `card_create`, `card_update`,
 * `card_assign`, `card_set_status` — `card.set_priority` folds into
 * `card_update` below, since there is no separate `setCardPriority` SERVICE
 * to wrap; priority "rides" `updateCard` for the identical reason
 * `card.service.ts`'s own doc comment gives a human editor no separate
 * route for it either).
 *
 * **Every one of these requires confirmation (§4.2), including create and
 * update** — the spec draft's own §4.2 illustrative text says single-card
 * create/update "can execute directly once permitted," but §4.3's Wave 2
 * ordering says the opposite for the exact same tools ("always confirmed
 * inline"). Rather than resolve a genuine self-contradiction in a document
 * marked DRAFT by guessing, this ships the more conservative reading:
 * nothing writes without an explicit human confirmation in this wave.
 * Loosening create/update to auto-execute later is a real, separate,
 * reviewable decision — the same posture §4.3 itself takes toward PR
 * merge/close ("loosening that later is a deliberate, separate decision").
 *
 * Every tool here builds a `WorkActor` from the SAME `Subject` the calling
 * member's own clicks would use, and calls the SAME service function a
 * human-facing route calls — so `enforceOn`'s `can()` check inside each one
 * is not duplicated, only reached from a second caller. A member who
 * cannot update a card cannot get the assistant to update it either; the
 * failure surfaces as a normal `ToolResult.isError`, not a crash.
 */

function actorOf(ctx: ToolContext): WorkActor {
  return { subject: ctx.subject, requestId: ctx.requestId };
}

/* ---------------------------------------------------------------------- *
 * card_create
 * ---------------------------------------------------------------------- */

const CardCreateInput = z
  .object({
    listId: ListIdSchema,
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(10_000).optional(),
  })
  .strict();

export function createCardCreateTool(): ToolDefinition {
  return defineTool({
    name: 'card_create',
    description:
      'Creates a new card in a list. The list must be identified by its id, not its name.',
    jsonSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The id of the list to create the card in.' },
        title: { type: 'string', description: 'The card title.' },
        description: { type: 'string', description: 'Optional plain-text description.' },
      },
      required: ['listId', 'title'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: CardCreateInput,
    async execute(ctx, input) {
      const result = await createCard(actorOf(ctx), {
        listId: input.listId,
        title: input.title,
        description: input.description === undefined ? null : plainParagraph(input.description),
      });
      return { content: JSON.stringify({ cardId: result.cardId, reference: result.reference }) };
    },
  });
}

/* ---------------------------------------------------------------------- *
 * card_update — title/description/dates/priority, read-then-patch
 * ---------------------------------------------------------------------- */

/**
 * `updateCard` is a full replace (CLAUDE.md's own documented trap for the
 * web client's `cards.update`). The fix here is the identical one
 * `apps/worker`'s automation executor already uses for `card.set_priority`:
 * read the card first, and pass every field back unchanged except the ones
 * the caller actually named. `'x' in patch` rather than `??`, because
 * clearing a date is `{ dueDate: null }` and `??` would treat that as "not
 * supplied" — the same reasoning `apps/web`'s own `useUpdateCard` documents.
 */
const CardUpdateInput = z
  .object({
    cardId: CardIdSchema,
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().max(10_000).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    startDate: z.string().datetime().nullable().optional(),
    priority: Priority.nullable().optional(),
  })
  .strict();

function descriptionOf(stored: unknown): RichTextNode | null {
  if (stored === null || stored === undefined) return null;
  const parsed = RichTextDocument.safeParse(stored);
  if (!parsed.success) {
    throw new Error("This card's description is not valid rich text, so it cannot be rewritten.");
  }
  return parsed.data;
}

export function createCardUpdateTool(): ToolDefinition {
  return defineTool({
    name: 'card_update',
    description:
      'Updates a card. Only the fields provided are changed; everything else is left as-is. Also used to set or clear a card’s priority.',
    jsonSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The id of the card to update.' },
        title: { type: 'string' },
        description: { type: 'string', description: 'Plain text; replaces the description.' },
        dueDate: { type: ['string', 'null'], description: 'ISO 8601 date-time, or null to clear.' },
        startDate: {
          type: ['string', 'null'],
          description: 'ISO 8601 date-time, or null to clear.',
        },
        priority: {
          type: ['string', 'null'],
          enum: [...Priority.options, null],
          description: 'One of urgent, high, normal, low; or null to clear.',
        },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: CardUpdateInput,
    async execute(ctx, input) {
      const actor = actorOf(ctx);
      const current = await getCard(actor, { cardId: input.cardId });

      const result = await updateCard(actor, {
        cardId: input.cardId,
        version: current.version,
        title: 'title' in input && input.title !== undefined ? input.title : current.title,
        description:
          'description' in input && input.description !== undefined
            ? plainParagraph(input.description)
            : descriptionOf(current.description),
        dueDate:
          'dueDate' in input && input.dueDate !== undefined
            ? input.dueDate === null
              ? null
              : new Date(input.dueDate)
            : current.dueDate,
        startDate:
          'startDate' in input && input.startDate !== undefined
            ? input.startDate === null
              ? null
              : new Date(input.startDate)
            : current.startDate,
        priority:
          'priority' in input && input.priority !== undefined ? input.priority : current.priority,
      });
      return { content: JSON.stringify({ version: result.version }) };
    },
  });
}

/* ---------------------------------------------------------------------- *
 * card_assign — ADDITIVE, never a replace
 * ---------------------------------------------------------------------- */

/**
 * `assignCard`'s real signature REPLACES the whole assignee list.
 * Additive here for the identical reason `apps/worker`'s automation
 * executor's own `card_assign` action is additive: "assign this to Bob"
 * spoken in a chat means ADD Bob, and a tool that silently unassigned
 * everyone else because the model did not enumerate them would do quiet
 * damage no confirmation step would even show clearly (the confirmation
 * prompt would need to say "and unassign these N people," which the model
 * was never asked to consider). A separate "unassign" tool is future work,
 * not a gap in this one's contract.
 */
const CardAssignInput = z
  .object({
    cardId: CardIdSchema,
    assigneeIds: z.array(UserIdSchema).min(1).max(20),
  })
  .strict();

export function createCardAssignTool(): ToolDefinition {
  return defineTool({
    name: 'card_assign',
    description:
      'Adds one or more people as assignees on a card, without removing anyone already assigned.',
    jsonSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The id of the card.' },
        assigneeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'User ids to add as assignees.',
        },
      },
      required: ['cardId', 'assigneeIds'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: CardAssignInput,
    async execute(ctx, input) {
      const actor = actorOf(ctx);
      const current = await getCard(actor, { cardId: input.cardId });
      const existing = new Set<UserId>(current.assigneeIds.map((id) => unsafeAsId<'UserId'>(id)));
      for (const id of input.assigneeIds) existing.add(id);

      const result = await assignCard(actor, {
        cardId: input.cardId,
        assigneeIds: [...existing],
      });
      return { content: JSON.stringify({ assigneeIds: result.assigneeIds }) };
    },
  });
}

/* ---------------------------------------------------------------------- *
 * card_set_status
 * ---------------------------------------------------------------------- */

const CardSetStatusInput = z
  .object({
    cardId: CardIdSchema,
    statusId: StatusIdSchema.nullable(),
  })
  .strict();

export function createCardSetStatusTool(): ToolDefinition {
  return defineTool({
    name: 'card_set_status',
    description: 'Moves a card to a different status column, or clears it with a null statusId.',
    jsonSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The id of the card.' },
        statusId: {
          type: ['string', 'null'],
          description: 'The id of the target status, or null to clear it.',
        },
      },
      required: ['cardId', 'statusId'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: CardSetStatusInput,
    async execute(ctx, input) {
      const result = await setCardStatus(actorOf(ctx), {
        cardId: input.cardId,
        statusId: input.statusId,
      });
      return { content: JSON.stringify({ statusId: result.statusId }) };
    },
  });
}
