import { z } from 'zod';
import type { SearchProvider } from '@taskflow/contracts';
import { performSearch } from '../../search/search.service.js';
import { defineTool, type ToolDefinition } from './registry.js';

/**
 * The `search` tool (§4.1) — a thin wrapper over `performSearch`, the exact
 * pipeline `search.query`'s own tRPC route runs. Read-only, so this needs
 * no confirm-before-execute (§4.2) and emits no domain event (guardrail 6
 * is about state mutation).
 *
 * The `limit` ceiling is far tighter than the route's own 100 — a tool
 * result becomes conversation history the model re-reads on every
 * subsequent turn, so a large result set is not merely slower, it is
 * tokens spent on every future turn of the SAME conversation.
 *
 * ## This tool's OWN example query used to send the model down a dead end
 *
 * `packages/filter/src/fields.ts`'s `SEARCH_FIELDS` is a genuinely
 * DIFFERENT closed field set from `CARD_FIELDS` — free-text discovery
 * (`type`/`title`/`text`/`author`/`updated`/`created`/`archived`) over
 * `search.documents`, with no `assignee` and no `due` at all (Phase 8's own
 * header: "the card and search field sets are both closed and they do NOT
 * overlap"). This tool's own example query used to be
 * `"status = open AND assignee = @me"` — syntactically valid TQL, but for
 * the WRONG resource, since `status` and `assignee` only exist on
 * `CARD_FIELDS`. A real transcript showed the cost: asked "what are my
 * pending tasks", the model tried that exact shape four times with minor
 * rewording, got a validation failure it had no way to diagnose as
 * architectural rather than a wording problem, and gave up. Fixed two ways:
 * the example below now uses only real search fields, and `my_cards`
 * (`my-cards.ts`) exists specifically to answer "what is assigned to me" /
 * "what is due" — this tool's own description now says so explicitly
 * rather than leaving the model to rediscover the boundary by trial and
 * error.
 */

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

const QUERY_EXAMPLE = 'type = page AND text contains "budget"';

const SearchToolInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe(`A TaskFlow Query Language (TQL) query, e.g. "${QUERY_EXAMPLE}"`),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export function createSearchTool(provider: SearchProvider): ToolDefinition {
  return defineTool({
    name: 'search',
    description:
      'Full-text search over cards, chat messages, docs pages, comments, and call transcripts ' +
      'using TaskFlow Query Language (TQL). Fields available here: type, title, text, author, ' +
      'updated, created, archived — there is NO assignee field and NO due-date field. For "what ' +
      'is assigned to me", "what is due", or "what is overdue", use the `my_cards` tool instead; ' +
      'it will not work here. Returns only results the current user is allowed to see.',
    jsonSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: `A TQL query, e.g. "${QUERY_EXAMPLE}"`,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum results to return (default ${String(DEFAULT_LIMIT)}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: SearchToolInput,
    async execute(ctx, input) {
      const hits = await performSearch(provider, ctx.subject, {
        query: input.query,
        limit: input.limit,
      });

      if (hits.length === 0) {
        return { content: 'No results.' };
      }

      // A compact projection, not the raw hit — `snippet`/`title` are what a
      // person would read off a search results page; `metadata` (board ids,
      // channel ids) is plumbing the model has no use for and the search
      // route itself only returns for the CLIENT to build a link with.
      const summarized = hits.map((hit) => ({
        type: hit.type,
        id: hit.entityId,
        title: hit.title,
        snippet: hit.snippet,
      }));

      return { content: JSON.stringify(summarized) };
    },
  });
}
