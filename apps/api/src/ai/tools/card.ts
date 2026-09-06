import { z } from 'zod';
import {
  CardIdSchema,
  LabelIdSchema,
  ListIdSchema,
  Priority,
  SprintIdSchema,
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
import { listCardLabels, setCardLabels } from '../../work/label.service.js';
import { assignSprint } from '../../work/sprint.service.js';
import { plainParagraph, RichTextDocument, type RichTextNode } from '../../work/richtext.js';
import type { WorkActor } from '../../work/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * The single-card write tools (§4.1's table: `card_create`, `card_update`,
 * `card_assign`, `card_set_status` — `card.set_priority` folds into
 * `card_update` below, since there is no separate `setCardPriority` SERVICE
 * to wrap; priority "rides" `updateCard` for the identical reason
 * `card.service.ts`'s own doc comment gives a human editor no separate
 * route for it either). `card_add_labels`, added later from a real request
 * to "tag" a card by name, wraps `setCardLabels` the same ADDITIVE way
 * `card_assign` wraps `assignCard` — see that tool's own comment below for
 * why the real service's full-replace semantics would be a mistake here.
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
    assigneeIds: z.array(UserIdSchema).max(20).optional(),
    labelIds: z.array(LabelIdSchema).max(20).optional(),
    priority: Priority.optional(),
    dueDate: z.string().datetime().optional(),
    sprintId: SprintIdSchema.optional(),
  })
  .strict();

/**
 * One tool call, every field the model was given — not "create, then a
 * separate confirmation to assign, then another to tag, then another for
 * the due date." Found from a real request to create a fully-specified
 * card ("project X, assign Y, tag Z, due Friday") in one prompt: the real
 * `createCard` SERVICE only ever took `listId`/`title`/`description` (a
 * limitation `apps/web`'s own card creation UI shares — a card is created
 * bare and edited after), and this tool inherited that limitation even
 * though nothing about `requiresConfirmation` requires it to. Confirmation
 * happens at the TOOL boundary, not the service boundary, so nothing stops
 * one tool from calling `createCard` and then `assignCard`/
 * `setCardLabels`/`updateCard`/`assignSprint` in sequence behind that SAME
 * single confirmation — each still runs through its own real `can()` check,
 * so bundling them changes nothing about what the caller is allowed to do,
 * only how many times a human has to click "Approve" to do it.
 *
 * `assigneeIds`/`labelIds` use `assignCard`/`setCardLabels` directly rather
 * than reading-then-unioning (`card_assign`/`card_add_labels`'s own
 * additive fix) — a card that was just created has nothing to accidentally
 * drop, so the real services' full-replace semantics are exactly what is
 * wanted here.
 *
 * A failure partway through is reported, not thrown — the card already
 * exists by the time `assigneeIds` or `labelIds` could fail (an id the
 * model resolved wrong, most commonly), and throwing at that point would
 * leave a real card behind while telling the model — and the person
 * reading its reply — that nothing happened. `warnings` names exactly what
 * did not apply, the identical "report per-item outcome, do not pretend
 * nothing happened" reasoning `sprint_add_cards` already uses for a batch.
 */
export function createCardCreateTool(): ToolDefinition {
  return defineTool({
    name: 'card_create',
    description:
      'Creates a new card in a list, optionally in the same call setting assignees, labels, ' +
      'priority, due date, and sprint — everything a person could set on the card-create form. ' +
      'The list, assignees, labels, and sprint must all be given by id, never by name; use ' +
      '`list_boards`, `list_members`, `list_labels`, and `list_sprints` first to resolve them.',
    jsonSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The id of the list to create the card in.' },
        title: { type: 'string', description: 'The card title.' },
        description: { type: 'string', description: 'Optional plain-text description.' },
        assigneeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional user ids to assign, from `list_members`.',
        },
        labelIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional label ids to tag with, from `list_labels`.',
        },
        priority: {
          type: 'string',
          enum: Priority.options,
          description: 'Optional priority: urgent, high, normal, or low.',
        },
        dueDate: { type: 'string', description: 'Optional ISO 8601 date-time.' },
        sprintId: {
          type: 'string',
          description: 'Optional sprint id to add the card to, from `list_sprints`.',
        },
      },
      required: ['listId', 'title'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: CardCreateInput,
    async execute(ctx, input) {
      const actor = actorOf(ctx);
      const created = await createCard(actor, {
        listId: input.listId,
        title: input.title,
        description: input.description === undefined ? null : plainParagraph(input.description),
      });

      const warnings: string[] = [];

      if (input.assigneeIds !== undefined) {
        try {
          await assignCard(actor, { cardId: created.cardId, assigneeIds: input.assigneeIds });
        } catch (error) {
          warnings.push(`Could not set assignees: ${messageOf(error)}`);
        }
      }

      if (input.labelIds !== undefined) {
        try {
          await setCardLabels(actor, { cardId: created.cardId, labelIds: input.labelIds });
        } catch (error) {
          warnings.push(`Could not set labels: ${messageOf(error)}`);
        }
      }

      if (input.priority !== undefined || input.dueDate !== undefined) {
        try {
          const current = await getCard(actor, { cardId: created.cardId });
          await updateCard(actor, {
            cardId: created.cardId,
            version: current.version,
            title: current.title,
            description: descriptionOf(current.description),
            dueDate: input.dueDate === undefined ? current.dueDate : new Date(input.dueDate),
            startDate: current.startDate,
            priority: input.priority ?? current.priority,
          });
        } catch (error) {
          warnings.push(`Could not set priority/due date: ${messageOf(error)}`);
        }
      }

      if (input.sprintId !== undefined) {
        try {
          await assignSprint(actor, { cardId: created.cardId, sprintId: input.sprintId });
        } catch (error) {
          warnings.push(`Could not add to sprint: ${messageOf(error)}`);
        }
      }

      return {
        content: JSON.stringify({
          cardId: created.cardId,
          reference: created.reference,
          ...(warnings.length > 0 ? { warnings } : {}),
        }),
      };
    },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'an unknown error';
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

/* ---------------------------------------------------------------------- *
 * card_add_labels — ADDITIVE, never a replace
 * ---------------------------------------------------------------------- */

const CardAddLabelsInput = z
  .object({
    cardId: CardIdSchema,
    labelIds: z.array(LabelIdSchema).min(1),
  })
  .strict();

export function createCardAddLabelsTool(): ToolDefinition {
  return defineTool({
    name: 'card_add_labels',
    description:
      'Adds one or more labels to a card, keeping any labels already on it. Use `list_labels` ' +
      "first to find a label's id from the name the user gave — this tool takes only ids, " +
      'never label names.',
    jsonSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The id of the card.' },
        labelIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of the labels to add, from `list_labels`.',
        },
      },
      required: ['cardId', 'labelIds'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: CardAddLabelsInput,
    async execute(ctx, input) {
      const actor = actorOf(ctx);
      // The real service REPLACES the whole set (`setCardLabels`'s own doc
      // comment: concurrent editors sending deltas would fight). "Add this
      // label" spoken in chat means ADD, exactly like `card_assign` below —
      // reading the current set first and union-ing is what makes silently
      // stripping every other tag on the card impossible.
      const existing = await listCardLabels(actor, { cardId: input.cardId });
      const union = [
        ...new Set([
          ...existing.map((label) => unsafeAsId<'LabelId'>(label.labelId)),
          ...input.labelIds,
        ]),
      ];
      const result = await setCardLabels(actor, { cardId: input.cardId, labelIds: union });
      return { content: JSON.stringify(result) };
    },
  });
}
