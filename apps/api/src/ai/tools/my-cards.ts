import { z } from 'zod';
import { inArray, schema, withOrgScope } from '@taskflow/db';
import { listMyCards } from '../../work/card.service.js';
import { orgOf, type WorkActor } from '../../work/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * The `my_cards` tool — "what is on my plate" — a real gap `search` cannot
 * fill, found from a real transcript where the assistant tried `search`
 * four times for "my pending tasks this week" and never found anything.
 *
 * ## `search` cannot answer this question, and never could
 *
 * `search`'s own field set (`packages/filter/src/fields.ts`'s
 * `SEARCH_FIELDS`) is `type`/`title`/`text`/`author`/`updated`/`created`/
 * `archived` — free-text discovery across Work, Chat and Docs. It has no
 * `assignee` field and no `due` field at all; those exist only in
 * `CARD_FIELDS`, a DIFFERENT closed field set `search.documents` was never
 * built to expose (Phase 8's own header: "the card and search field sets
 * are both closed and they do NOT overlap"). `search`'s tool description
 * even offered `"status = open AND assignee = @me"` as an EXAMPLE query —
 * syntactically valid TQL, semantically wrong resource, so every attempt
 * failed validation and the model kept retrying different phrasings with no
 * way to know the real problem was architectural, not a wording issue. That
 * example is now search.ts's own header calling this tool out by name
 * instead.
 *
 * `my_cards` answers the actual question by wrapping `listMyCards` — the
 * same real, per-row-authorized, cross-board query `work.cards.mine`
 * (My Tasks) already runs — rather than inventing a second one. A member
 * who cannot see a board loses that card from the assistant's answer
 * exactly as they would from the My Tasks page itself.
 *
 * ## "Pending" is filtered HERE, deterministically — never left to the model
 *
 * `listMyCards` has no notion of done/not-done in its own output; a card's
 * `statusId` is an opaque id with no category attached (My Tasks / the
 * board resolve names client-side from a separately-fetched status list).
 * Handing the model a bag of statusIds and trusting it to infer "pending"
 * from ids it has never seen would repeat the exact mistake this codebase's
 * standup narration already corrected once (CLAUDE.md's own account of
 * that redesign) — classification stays deterministic, so this tool
 * resolves each card's status CATEGORY itself, in one batched lookup over
 * the distinct status ids actually present, and excludes `done` before the
 * model ever sees a card. What reaches the model is already "pending" —
 * there is nothing left for it to classify.
 */

const MyCardsInput = z.object({}).strict();

function actorOf(ctx: ToolContext): WorkActor {
  return { subject: ctx.subject, requestId: ctx.requestId };
}

export function createMyCardsTool(): ToolDefinition {
  return defineTool({
    name: 'my_cards',
    description:
      "Lists the current user's own PENDING (not-done) cards across every board they can " +
      'access, ordered by due date soonest first, each with its due date so you can reason ' +
      'about "this week", "overdue", etc. yourself. Use this for any question about what the ' +
      'user is assigned, what is due, or what is overdue for them — the `search` tool cannot ' +
      'filter by assignee or due date at all and will not answer these questions.',
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiresConfirmation: false,
    inputSchema: MyCardsInput,
    async execute(ctx) {
      const actor = actorOf(ctx);
      const cards = await listMyCards(actor, { includeArchived: false });
      if (cards.length === 0) {
        return { content: 'No cards are assigned to the user.' };
      }

      const statusIds = [
        ...new Set(cards.flatMap((card) => (card.statusId === null ? [] : [card.statusId]))),
      ];
      const categoryByStatusId =
        statusIds.length === 0
          ? new Map<string, string>()
          : await withOrgScope(orgOf(actor), async (tx) => {
              const rows = await tx
                .select({ id: schema.statuses.id, category: schema.statuses.category })
                .from(schema.statuses)
                .where(inArray(schema.statuses.id, statusIds));
              return new Map(rows.map((row) => [row.id, row.category]));
            });

      const pending = cards.filter(
        (card) => card.statusId === null || categoryByStatusId.get(card.statusId) !== 'done',
      );
      if (pending.length === 0) {
        return { content: 'Nothing pending — every card assigned to the user is done.' };
      }

      const summarized = pending.map((card) => ({
        reference: card.reference,
        title: card.title,
        priority: card.priority,
        dueDate: card.dueDate === null ? null : card.dueDate.toISOString(),
      }));

      return { content: JSON.stringify(summarized) };
    },
  });
}
