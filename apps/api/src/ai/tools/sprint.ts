import { z } from 'zod';
import { CardIdSchema, ProjectIdSchema, SprintIdSchema } from '@taskflow/contracts';
import { assignSprint, createSprint } from '../../work/sprint.service.js';
import type { WorkActor } from '../../work/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * Sprint planning tools (§4.1's table: `sprint_create`, `sprint_add_cards`) —
 * §4.3 Wave 3, "multi-card, higher blast radius" than Wave 2's single-card
 * writes. Both require confirmation (§4.2), and here the spec draft has no
 * internal contradiction to resolve the way Wave 2's `card_create`/
 * `card_update` did: §4.2 names "sprint creation" itself as an example of an
 * action needing confirmation, and moving many cards is its own named
 * example of a bulk operation that does too.
 *
 * As with Wave 2's tools, every call here builds a `WorkActor` from the
 * calling member's own `Subject` and reaches the real
 * `apps/api/src/work/sprint.service.ts` function a human's own click would
 * — the same `can()` check (`project:update` for planning the sprint itself,
 * `card:update` per card moved into it), never a second copy of it.
 */

function actorOf(ctx: ToolContext): WorkActor {
  return { subject: ctx.subject, requestId: ctx.requestId };
}

/**
 * `YYYY-MM-DD`, mirroring `work/router.ts`'s own (unexported) `Day` schema
 * exactly — a real calendar date, not just a string matching the shape of
 * one, since `new Date('2024-02-30')` rolls over to March rather than
 * failing, and a sprint silently dated a week off its stated boundary is
 * the kind of error a human confirming the prompt is unlikely to catch by
 * reading a JSON blob.
 */
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Use a real calendar date.');

/* ---------------------------------------------------------------------- *
 * sprint_create
 * ---------------------------------------------------------------------- */

const SprintCreateInput = z
  .object({
    projectId: ProjectIdSchema,
    name: z.string().trim().min(1).max(120),
    goal: z.string().trim().max(2_000).optional(),
    startsOn: Day,
    endsOn: Day,
  })
  .strict();

export function createSprintCreateTool(): ToolDefinition {
  return defineTool({
    name: 'sprint_create',
    description: 'Plans a new sprint for a project, in the "planned" state.',
    jsonSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The id of the project to plan the sprint in.' },
        name: { type: 'string', description: 'The sprint name, e.g. "Sprint 14".' },
        goal: { type: 'string', description: 'Optional one-paragraph goal statement.' },
        startsOn: { type: 'string', description: 'YYYY-MM-DD.' },
        endsOn: { type: 'string', description: 'YYYY-MM-DD, on or after startsOn.' },
      },
      required: ['projectId', 'name', 'startsOn', 'endsOn'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: SprintCreateInput,
    async execute(ctx, input) {
      const result = await createSprint(actorOf(ctx), {
        projectId: input.projectId,
        name: input.name,
        goal: input.goal ?? null,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      });
      return { content: JSON.stringify({ sprintId: result.sprintId }) };
    },
  });
}

/* ---------------------------------------------------------------------- *
 * sprint_add_cards
 * ---------------------------------------------------------------------- */

const SprintAddCardsInput = z
  .object({
    sprintId: SprintIdSchema,
    cardIds: z.array(CardIdSchema).min(1).max(50),
  })
  .strict();

/**
 * There is no bulk `assignSprint` in the service layer, only a per-card one
 * — this loops it, sequentially (not `Promise.all`, the same ordering
 * guarantee every write tool in this registry keeps), and reports each
 * card's own outcome rather than aborting the whole batch on the first
 * failure. `apps/worker`'s automation executor stops at the first failed
 * ACTION in a rule because a rule is unattended and a partial run with no
 * one watching needs a clean stop point to retry from; this tool ran only
 * after a human explicitly confirmed moving THESE cards, so leaving the
 * other 49 undone because card 3 was already in a completed sprint is
 * worse for them, not safer — they can see exactly which ones failed and
 * why, and decide what to do about just those.
 */
export function createSprintAddCardsTool(): ToolDefinition {
  return defineTool({
    name: 'sprint_add_cards',
    description: 'Adds one or more cards to a sprint (moves them out of any other sprint).',
    jsonSchema: {
      type: 'object',
      properties: {
        sprintId: { type: 'string', description: 'The id of the target sprint.' },
        cardIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'The ids of the cards to add.',
        },
      },
      required: ['sprintId', 'cardIds'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: SprintAddCardsInput,
    async execute(ctx, input) {
      const actor = actorOf(ctx);
      const succeeded: string[] = [];
      const failed: { readonly cardId: string; readonly reason: string }[] = [];

      for (const cardId of input.cardIds) {
        try {
          await assignSprint(actor, { cardId, sprintId: input.sprintId });
          succeeded.push(cardId);
        } catch (error) {
          failed.push({
            cardId,
            reason: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }

      return {
        content: JSON.stringify({ succeeded, failed }),
        ...(succeeded.length === 0 ? { isError: true } : {}),
      };
    },
  });
}
